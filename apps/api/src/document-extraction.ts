import { extname } from "node:path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { parseDelimited } from "./managed-store.js";

export const DOCUMENT_UPLOAD_EXTENSIONS = [
  ".pdf", ".csv", ".json", ".txt", ".jpg", ".jpeg", ".png", ".heic",
  ".doc", ".docx", ".xls", ".xlsx", ".zip", ".wav",
] as const;

const ARCHIVE_EXTRACTABLE_EXTENSIONS = new Set(
  DOCUMENT_UPLOAD_EXTENSIONS.filter((extension) => ![".zip"].includes(extension)),
);
const MAX_ARCHIVE_ENTRIES = 250;
const MAX_ARCHIVE_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

export type ArchiveEntryExtraction = {
  path: string;
  sizeBytes: number;
  status: DocumentExtraction["status"] | "skipped";
  format: string;
  textLength?: number;
  warnings: string[];
  error?: string;
};

export type DocumentExtraction = {
  status: "extracted" | "empty" | "needs_ocr" | "unsupported" | "failed";
  format: string;
  text?: string;
  textLength?: number;
  pageCount?: number;
  sheets?: Array<{ name: string; rows: number; preview: unknown[][] }>;
  rows?: Record<string, unknown>[];
  archive?: {
    totalEntries: number;
    extractedEntries: number;
    skippedEntries: number;
    totalUncompressedBytes: number;
    entries: ArchiveEntryExtraction[];
  };
  warnings: string[];
  error?: string;
};

const trimText = (value: string) => value.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim().slice(0, 200_000);

type ZipEntryMetadata = {
  compressedSize?: number;
  uncompressedSize?: number;
};

export type SafeArchiveEntry = {
  path: string;
  extension: string;
  sizeBytes: number;
  content: Buffer;
};

function unsafeArchivePath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return normalized.includes("\u0000") || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)
    || normalized.split("/").some((segment) => segment === "..");
}

/** Lê entradas de ZIP depois de aplicar todos os limites de segurança. */
export async function readSafeArchiveEntries(buffer: Buffer): Promise<SafeArchiveEntry[]> {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (files.length > MAX_ARCHIVE_ENTRIES) throw new Error(`ZIP excede o limite de ${MAX_ARCHIVE_ENTRIES} arquivos.`);

  let declaredTotal = 0;
  const inspected = files.map((entry) => {
    const unsafeOriginalName = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (unsafeArchivePath(unsafeOriginalName)) throw new Error("ZIP contém caminho inseguro (path traversal)." );
    const metadata = (entry as typeof entry & { _data?: ZipEntryMetadata })._data;
    const uncompressedSize = Number(metadata?.uncompressedSize ?? 0);
    const compressedSize = Number(metadata?.compressedSize ?? 0);
    if (!Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0) throw new Error("ZIP contém tamanho de arquivo inválido.");
    if (uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) throw new Error(`Arquivo ${entry.name} excede 10 MB após descompactação.`);
    if (uncompressedSize > 1024 * 1024 && compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
      throw new Error(`Arquivo ${entry.name} excede a razão de compressão segura.`);
    }
    declaredTotal += uncompressedSize;
    if (declaredTotal > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error("ZIP excede 50 MB após descompactação.");
    return { entry, uncompressedSize };
  });

  const entries: SafeArchiveEntry[] = [];
  for (const { entry, uncompressedSize } of inspected) {
    const content = await entry.async("nodebuffer");
    if (content.length > MAX_ARCHIVE_ENTRY_BYTES) throw new Error(`Arquivo ${entry.name} excede 10 MB após descompactação.`);
    entries.push({ path: entry.name, extension: extname(entry.name).toLowerCase(), sizeBytes: content.length || uncompressedSize, content });
  }
  return entries;
}

/**
 * Converte um XLSX em registros usando a primeira linha não vazia de cada aba
 * como cabeçalho. Fórmulas/valores são preservados como valores calculados ou
 * texto; a aba permanece no campo `__sheet` para auditoria.
 */
export async function extractSpreadsheetRows(buffer: Buffer): Promise<Record<string, unknown>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const scalar = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (value && typeof value === "object") {
      const formula = value as { result?: unknown; formula?: string; text?: string };
      return formula.result ?? formula.text ?? formula.formula ?? JSON.stringify(value);
    }
    return value ?? "";
  };
  const rows: Record<string, unknown>[] = [];
  for (const sheet of workbook.worksheets) {
    const values: unknown[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => values.push((row.values as unknown[]).slice(1).map(scalar)));
    if (!values.length) continue;
    const headerValues = values[0] ?? [];
    const usedHeaders = new Map<string, number>();
    const headers = headerValues.map((value, index) => {
      const base = String(value ?? "").replace(/^\uFEFF/, "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9_]+/gi, "_").replace(/^_+|_+$/g, "") || `column_${index + 1}`;
      const occurrence = (usedHeaders.get(base) ?? 0) + 1;
      usedHeaders.set(base, occurrence);
      return occurrence === 1 ? base : `${base}_${occurrence}`;
    });
    for (const valuesRow of values.slice(1)) {
      if (!valuesRow.some((value) => value !== "" && value !== null && value !== undefined)) continue;
      const record: Record<string, unknown> = { __sheet: sheet.name };
      headers.forEach((header, index) => { record[header] = valuesRow[index] ?? ""; });
      rows.push(record);
    }
  }
  return rows;
}

async function extractArchive(buffer: Buffer): Promise<DocumentExtraction> {
  const files = await readSafeArchiveEntries(buffer);
  const entries: ArchiveEntryExtraction[] = [];
  const textParts: string[] = [];
  for (const file of files) {
    const extension = file.extension;
    if (extension === ".zip") {
      entries.push({ path: file.path, sizeBytes: file.sizeBytes, status: "skipped", format: "zip", warnings: ["ZIP aninhado não é processado por segurança."] });
      continue;
    }
    if (!ARCHIVE_EXTRACTABLE_EXTENSIONS.has(extension as (typeof DOCUMENT_UPLOAD_EXTENSIONS)[number])) {
      entries.push({ path: file.path, sizeBytes: file.sizeBytes, status: "skipped", format: extension.slice(1) || "unknown", warnings: ["Formato não suportado dentro do ZIP; original preservado no arquivo principal."] });
      continue;
    }
    if (!signatureMatches(file.content, extension)) throw new Error(`O conteúdo de ${file.path} não corresponde à extensão informada.`);
    const extraction = await extractDocument(file.content, file.path);
    entries.push({ path: file.path, sizeBytes: file.sizeBytes, status: extraction.status, format: extraction.format, textLength: extraction.textLength, warnings: extraction.warnings, error: extraction.error });
    if (extraction.text) textParts.push(`### ${file.path}\n${extraction.text}`);
  }
  const text = trimText(textParts.join("\n\n"));
  const extractedEntries = entries.filter((entry) => entry.status === "extracted").length;
  const skippedEntries = entries.filter((entry) => entry.status === "skipped" || entry.status === "unsupported").length;
  return {
    status: extractedEntries > 0 ? "extracted" : entries.some((entry) => entry.status === "needs_ocr") ? "needs_ocr" : "empty",
    format: "zip",
    text: text || undefined,
    textLength: text.length,
    archive: { totalEntries: files.length, extractedEntries, skippedEntries, totalUncompressedBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), entries },
    warnings: skippedEntries ? [`${skippedEntries} arquivo(s) do ZIP não foram extraídos; consulte o relatório por item.`] : [],
  };
}

export async function extractDocument(buffer: Buffer, filename: string): Promise<DocumentExtraction> {
  const extension = extname(filename).toLowerCase();
  try {
    if (extension === ".zip") return await extractArchive(buffer);
    if ([".txt", ".csv", ".json"].includes(extension)) {
      const text = trimText(buffer.toString("utf8"));
      if (!text) return { status: "empty", format: extension.slice(1), warnings: ["Arquivo sem conteúdo textual."] };
      if (extension === ".csv") {
        const rows = parseDelimited(text);
        return { status: rows.length ? "extracted" : "empty", format: "csv", text, textLength: text.length, rows: rows.slice(0, 5000), warnings: rows.length > 5000 ? ["Prévia limitada às primeiras 5.000 linhas."] : [] };
      }
      if (extension === ".json") {
        const parsed = JSON.parse(text) as unknown;
        return { status: "extracted", format: "json", text: JSON.stringify(parsed, null, 2).slice(0, 200_000), textLength: text.length, warnings: [] };
      }
      return { status: "extracted", format: "txt", text, textLength: text.length, warnings: [] };
    }
    if (extension === ".pdf") {
      const parser = new PDFParse({ data: buffer });
      try {
        const parsed = await parser.getText();
        const text = trimText(parsed.text);
        return { status: text ? "extracted" : "needs_ocr", format: "pdf", text: text || undefined, textLength: text.length, pageCount: parsed.total, warnings: text ? [] : ["PDF sem camada de texto. Encaminhe para OCR antes da confirmação humana."] };
      } finally { await parser.destroy(); }
    }
    if (extension === ".docx") {
      const parsed = await mammoth.extractRawText({ buffer });
      const text = trimText(parsed.value);
      return { status: text ? "extracted" : "empty", format: "docx", text: text || undefined, textLength: text.length, warnings: parsed.messages.map((message) => message.message).slice(0, 20) };
    }
    if ([".xlsx", ".xls"].includes(extension)) {
      if (extension === ".xls") return { status: "unsupported", format: "xls", warnings: ["Formato XLS legado preservado. Converta para XLSX para extração estruturada."] };
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
      const sheets = workbook.worksheets.map((sheet) => {
        const preview: unknown[][] = [];
        sheet.eachRow({ includeEmpty: false }, (row) => {
          if (preview.length < 100) preview.push((row.values as unknown[]).slice(1).map((value) => value instanceof Date ? value.toISOString() : value));
        });
        return { name: sheet.name, rows: sheet.actualRowCount, preview };
      });
      return { status: sheets.some((sheet) => sheet.rows) ? "extracted" : "empty", format: "xlsx", sheets, warnings: sheets.some((sheet) => sheet.rows > 100) ? ["Prévia limitada às primeiras 100 linhas de cada planilha."] : [] };
    }
    if ([".jpg", ".jpeg", ".png", ".heic"].includes(extension)) return { status: "needs_ocr", format: extension.slice(1), warnings: ["Imagem preservada com hash. OCR local ainda requer o pacote de idioma português homologado."] };
    if (extension === ".doc") return { status: "unsupported", format: "doc", warnings: ["Formato DOC legado preservado. Converta para DOCX para extração segura."] };
    return { status: "unsupported", format: extension.slice(1) || "unknown", warnings: ["O original foi preservado, mas não há extrator textual para este formato."] };
  } catch (error) {
    return { status: "failed", format: extension.slice(1) || "unknown", warnings: [], error: error instanceof Error ? error.message : "Falha na extração" };
  }
}

export function signatureMatches(buffer: Buffer, extension: string) {
  const ext = extension.toLowerCase();
  if (ext === ".wav") return buffer.length >= 44 && buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WAVE";
  if (ext === ".pdf") return buffer.subarray(0, 5).toString() === "%PDF-";
  if ([".docx", ".xlsx", ".zip"].includes(ext)) return buffer[0] === 0x50 && buffer[1] === 0x4b
    && [[0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].some(([third, fourth]) => buffer[2] === third && buffer[3] === fourth);
  if (ext === ".png") return buffer.subarray(1, 4).toString() === "PNG";
  if ([".jpg", ".jpeg"].includes(ext)) return buffer[0] === 0xff && buffer[1] === 0xd8;
  if ([".mp4", ".m4v", ".mov"].includes(ext)) return buffer.subarray(4, 12).includes(Buffer.from("ftyp"));
  return true;
}
