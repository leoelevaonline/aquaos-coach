import type { FastifyInstance } from "fastify";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { ManagedStore, parseDelimited, resourceKinds, type ResourceKind } from "./managed-store.js";
import { athleteMayAccess, getSession, roleAllows, sessionToken } from "./auth.js";
import { DOCUMENT_UPLOAD_EXTENSIONS, extractDocument, extractSpreadsheetRows, readSafeArchiveEntries, signatureMatches } from "./document-extraction.js";
import { pipeline } from "node:stream/promises";
import type { VideoAnalysisQueue } from "./video-analysis-queue.js";

export const uploadRoot = process.env.STORAGE_PATH
  ? resolve(process.env.STORAGE_PATH, "uploads")
  : fileURLToPath(new URL("../storage/uploads/", import.meta.url));
mkdirSync(uploadRoot, { recursive: true });

const kindSchema = z.enum(resourceKinds);
const bodySchema = z.record(z.unknown());
const safeName = (name: string) => basename(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").toLowerCase();
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const importAliases: Record<string, string> = {
  nome: "name", nome_completo: "name", e_mail: "email", usuario: "handle", grupo: "group", status: "status",
  atleta: "athleteId", atleta_id: "athleteId", id_atleta: "athleteId", data: "date", data_do_treino: "date",
  data_de_nascimento: "birthDate", nascimento: "birthDate", zona: "zone", zona_principal: "zone",
  volume: "distanceMeters", volume_m: "distanceMeters", distancia: "distanceMeters", distancia_m: "distanceMeters",
  repeticoes: "repetitions", repeticoes_parseadas: "repetitions", observacoes: "notes", notas: "notes",
};
const normalizeImportKey = (key: string) => key.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const canonicalizeImportRow = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [importAliases[normalizeImportKey(key)] ?? key, value]));

type Keyframe = { t: number; persons: Array<{ id: number; kpts: number[][] }> };
type KeyframeSegment = { from: number; to: number; count: number; keyframes: Keyframe[] };

function withoutKeyframeEvidence(record: Record<string, unknown>) {
  const analysis = record.analysis as Record<string, unknown> | undefined;
  if (!analysis) return record;
  const { keyframes: _legacyKeyframes, keyframeSegments, ...summary } = analysis;
  const segments = Array.isArray(keyframeSegments) ? keyframeSegments.map((segment) => {
    const { keyframes: _frames, ...index } = segment as KeyframeSegment;
    return index;
  }) : undefined;
  return { ...record, analysis: { ...summary, ...(segments ? { keyframeSegments: segments } : {}) } };
}

function keyframesInWindow(analysis: Record<string, unknown>, from: number, to: number): Keyframe[] {
  const segments = analysis.keyframeSegments;
  if (Array.isArray(segments)) {
    return segments.flatMap((segment) => {
      const item = segment as KeyframeSegment;
      return item.to >= from && item.from <= to ? item.keyframes : [];
    }).filter((frame) => frame.t >= from && frame.t <= to);
  }
  // Análises anteriores persistiam um único vetor; leia-o sem exigir migração.
  return Array.isArray(analysis.keyframes) ? (analysis.keyframes as Keyframe[]).filter((frame) => frame.t >= from && frame.t <= to) : [];
}

export function registerOperationalRoutes(app: FastifyInstance, store: ManagedStore, videoQueue?: VideoAnalysisQueue) {
  const protectedKinds = ["ingestions", "prescriptions", "results", "loadSnapshots", "adaptationDecisions", "governance", "users", "authSessions", "videoAnalysisJobs", "invitations"];
  app.get("/api/v1/events", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!user) return reply.code(401).send({ error: "Autenticação necessária" });
    reply.hijack();
    const requestOrigin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const allowedStreamOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((origin) => origin.trim());
    const streamHeaders: Record<string, string> = {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    };
    if (requestOrigin && allowedStreamOrigins.includes(requestOrigin)) {
      streamHeaders["Access-Control-Allow-Origin"] = requestOrigin;
      streamHeaders["Access-Control-Allow-Credentials"] = "true";
    }
    reply.raw.writeHead(200, streamHeaders);
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);
    const unsubscribe = store.subscribe((event) => {
      if (event.organizationId !== user.organizationId) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(": keep-alive\n\n"), 25_000);
    request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
    return reply;
  });
  app.get("/api/v1/analytics/overview", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" });
    const query = z.object({ weeks: z.coerce.number().min(1).max(52).default(8) }).parse(request.query);
    return store.analytics(query.weeks, user!.organizationId);
  });
  app.get("/api/v1/manage", async (request, reply) => { const user = await getSession(sessionToken(request)); if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" }); return { resources: Object.fromEntries(resourceKinds.map((kind) => [kind, store.list(kind).filter((item) => item.organizationId === user!.organizationId).length])), kinds: resourceKinds, audit: store.audit(15).filter((entry) => (entry.organizationId ?? "org-demo") === user!.organizationId) }; });
  app.get("/api/v1/manage/audit", async (request, reply) => { const user = await getSession(sessionToken(request)); if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" }); const query = z.object({ limit: z.coerce.number().min(1).max(500).default(100) }).parse(request.query); return { data: store.audit(500).filter((entry) => (entry.organizationId ?? "org-demo") === user!.organizationId).slice(0, query.limit) }; });

  app.get("/api/v1/manage/:kind", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" });
    const parsed = kindSchema.safeParse((request.params as { kind?: string }).kind);
    if (!parsed.success) return reply.code(404).send({ error: "Módulo não encontrado" });
    if (["users", "authSessions"].includes(parsed.data)) return reply.code(403).send({ error: "Dados de credenciais não podem ser consultados pelo CRUD genérico" });
    const query = z.object({ q: z.string().trim().default(""), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    const all = store.list(parsed.data).filter((item) => item.organizationId === user!.organizationId);
    const filtered = query.q ? all.filter((item) => JSON.stringify(item).toLowerCase().includes(query.q.toLowerCase())) : all;
    const data = filtered.slice(query.offset, query.offset + query.limit).map((record) => parsed.data === "videos" ? withoutKeyframeEvidence(record) : record);
    return { data, total: filtered.length, offset: query.offset, limit: query.limit };
  });
  app.get("/api/v1/manage/:kind/:id", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" });
    const params = z.object({ kind: kindSchema, id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "Registro inválido" });
    if (["users", "authSessions"].includes(params.data.kind)) return reply.code(403).send({ error: "Dados de credenciais não podem ser consultados pelo CRUD genérico" });
    const record = store.get(params.data.kind, params.data.id);
    return record && record.organizationId === user!.organizationId ? reply.send(params.data.kind === "videos" ? withoutKeyframeEvidence(record) : record) : reply.code(404).send({ error: "Registro não encontrado" });
  });
  app.post("/api/v1/manage/:kind", async (request, reply) => {
    const kind = kindSchema.safeParse((request.params as { kind?: string }).kind);
    const body = bodySchema.safeParse(request.body);
    if (!kind.success || !body.success) return reply.code(400).send({ error: "Dados inválidos" });
    const user = await getSession(sessionToken(request));
    const athleteActivity = kind.data === "activities" && user?.role === "athlete";
    if (!roleAllows(user, ["coach", "admin"]) && !athleteActivity) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" });
    if (protectedKinds.includes(kind.data)) return reply.code(403).send({ error: "Use o fluxo RKF dedicado para preservar auditoria e imutabilidade" });
    if (kind.data === "athletes" && typeof body.data.email === "string") {
      const duplicate = store.list("athletes").find((record) => record.organizationId === user!.organizationId && String(record.email ?? "").toLowerCase() === body.data.email!.toString().trim().toLowerCase());
      if (duplicate) return reply.code(409).send({ error: "Já existe um atleta com este e-mail nesta organização" });
    }
    const athleteScoped = athleteActivity ? { ...body.data, athleteId: user!.athleteId } : body.data;
    const created = store.create(kind.data, { ...athleteScoped, organizationId: user!.organizationId, actorId: user!.id });
    if (kind.data === "workouts" && body.data.status === "published") {
      const targetType = ["team", "group", "athlete"].includes(String(body.data.targetType)) ? String(body.data.targetType) : undefined;
      const targetId = typeof body.data.targetId === "string" ? body.data.targetId : undefined;
      if (targetType && targetId) {
        const athleteId = targetType === "athlete" ? targetId : `target:${targetType}:${targetId}`;
        const prescription = store.create("prescriptions", { workoutId: created.id, athleteId, title: String(created.title ?? "Treino publicado"), targetType, targetId, prescription: { totalVolumeM: Number(created.distanceMeters ?? 0), primaryZone: created.zone, text: created.prescriptionText, blocks: created.blocks }, status: "PUBLISHED", immutable: true, approvedBy: user!.id, approvedAt: new Date().toISOString(), organizationId: user!.organizationId, actorId: user!.id }, "create");
        return reply.code(201).send({ ...created, prescriptionId: prescription.id });
      }
    }
    if (kind.data === "athletes" && created.status === "invited" && typeof created.email === "string") {
      const token = randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
      store.create("invitations", { athleteId: created.id, email: created.email, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt, status: "pending", organizationId: user!.organizationId, actorId: user!.id });
      const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
      return reply.code(201).send({ ...created, invitation: { url: `${baseUrl}/pt/athlete/access?invite=${token}`, token, expiresAt } });
    }
    return reply.code(201).send(created);
  });
  app.patch("/api/v1/manage/:kind/:id", async (request, reply) => {
    const params = z.object({ kind: kindSchema, id: z.string() }).safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Dados inválidos" });
    const user = await getSession(sessionToken(request));
    const athleteSelfEdit = params.data.kind === "athletes" && user?.role === "athlete" && athleteMayAccess(user, params.data.id);
    if (!roleAllows(user, ["coach", "admin"]) && !athleteSelfEdit) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" });
    if (protectedKinds.includes(params.data.kind)) return reply.code(403).send({ error: "Registro RKF protegido contra alteração genérica" });
    const existingRecord = store.get(params.data.kind, params.data.id);
    if (!existingRecord || existingRecord.organizationId !== user!.organizationId) return reply.code(404).send({ error: "Registro não encontrado" });
    const { id: _id, organizationId: _organizationId, actorId: _actorId, createdAt: _createdAt, ...safePatch } = body.data;
    const record = store.update(params.data.kind, params.data.id, { ...safePatch, actorId: user!.id });
    return record ? reply.send(record) : reply.code(404).send({ error: "Registro não encontrado" });
  });
  app.delete("/api/v1/manage/:kind/:id", async (request, reply) => {
    const params = z.object({ kind: kindSchema, id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Registro inválido" });
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" });
    if (protectedKinds.includes(params.data.kind)) return reply.code(403).send({ error: "Registro RKF protegido contra exclusão genérica" });
    const scopedRecord = store.get(params.data.kind, params.data.id);
    if (!scopedRecord || scopedRecord.organizationId !== user!.organizationId) return reply.code(404).send({ error: "Registro não encontrado" });
    const existing = store.get(params.data.kind, params.data.id);
    if (existing && (params.data.kind === "videos" || params.data.kind === "documents")) {
      for (const fileName of [existing.filename, typeof existing.thumbnailUrl === "string" ? basename(existing.thumbnailUrl) : undefined]) {
        if (typeof fileName !== "string") continue;
        const target = resolve(uploadRoot, fileName);
        const root = `${resolve(uploadRoot)}${sep}`;
        if (target.startsWith(root) && existsSync(target)) unlinkSync(target);
      }
    }
    const record = store.remove(params.data.kind, params.data.id);
    return record ? reply.send({ ok: true, deleted: record }) : reply.code(404).send({ error: "Registro não encontrado" });
  });

  app.post("/api/v1/uploads", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!user) return reply.code(401).send({ error: "Autenticação necessária" });
    const query = z.object({ kind: z.enum(["videos", "documents"]).default("documents"), athleteId: z.string().optional(), title: z.string().trim().max(180).optional(), referenceType: z.string().trim().max(80).optional(), referenceId: z.string().trim().max(160).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Parâmetros do upload inválidos" });
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "Selecione um arquivo" });
    const extension = extname(file.filename).toLowerCase();
    const allowed = [".mp4", ".mov", ".m4v", ".fit", ...DOCUMENT_UPLOAD_EXTENSIONS];
    if (!allowed.includes(extension)) return reply.code(415).send({ error: `Formato ${extension || "desconhecido"} não permitido` });
    if (extension === ".fit") return reply.code(422).send({ error: "Arquivos FIT devem ser importados no módulo Atividades; use /api/v1/import/activities." });
    const filename = `${Date.now()}-${safeName(file.filename)}`;
    if (user.role === "athlete" && query.data.athleteId && !athleteMayAccess(user, query.data.athleteId)) return reply.code(403).send({ error: "Atleta só pode anexar arquivos ao próprio prontuário" });
    const resource = query.data.kind === "videos" ? "videos" : "documents";
    const target = resolve(uploadRoot, filename);
    let sizeBytes = 0;
    let sha256 = "";
    let extraction: Awaited<ReturnType<typeof extractDocument>> | undefined;
    if (resource === "videos") {
      const temporary = `${target}.uploading`;
      const hash = createHash("sha256");
      file.file.on("data", (chunk: Buffer) => hash.update(chunk));
      try {
        await pipeline(file.file, createWriteStream(temporary, { flags: "wx" }));
        sizeBytes = statSync(temporary).size;
        const descriptor = openSync(temporary, "r");
        const header = Buffer.alloc(16); const bytes = readSync(descriptor, header, 0, header.length, 0); closeSync(descriptor);
        if (!signatureMatches(header.subarray(0, bytes), extension)) { unlinkSync(temporary); return reply.code(415).send({ error: "O conteúdo do vídeo não corresponde à extensão informada" }); }
        sha256 = hash.digest("hex");
        renameSync(temporary, target);
      } catch (error) {
        if (existsSync(temporary)) unlinkSync(temporary);
        throw error;
      }
    } else {
      const buffer = await file.toBuffer();
      if (!signatureMatches(buffer, extension)) return reply.code(415).send({ error: "O conteúdo do arquivo não corresponde à extensão informada" });
      if (buffer.length > 25 * 1024 * 1024) return reply.code(413).send({ error: "Documentos devem ter no máximo 25 MB" });
      sizeBytes = buffer.length; sha256 = createHash("sha256").update(buffer).digest("hex");
      extraction = await extractDocument(buffer, file.filename);
      writeFileSync(target, buffer);
    }
    const duplicate = store.list(resource).find((item) => item.organizationId === user.organizationId && item.sha256 === sha256);
    if (duplicate) { if (existsSync(target)) unlinkSync(target); return reply.code(200).send({ ...duplicate, duplicate: true }); }
    const record = store.create(resource, {
      title: query.data.title ?? file.filename.replace(extension, ""), filename, originalName: file.filename,
      mimeType: file.mimetype, sizeBytes, url: `/uploads/${filename}`, athleteId: query.data.athleteId,
      referenceType: query.data.referenceType, referenceId: query.data.referenceId,
      status: resource === "videos" ? "processing" : "ready", analysisStatus: resource === "videos" ? "pending" : undefined,
      organizationId: user.organizationId, actorId: user.id, sha256,
      extractionStatus: extraction?.status, extraction,
    }, "upload");
    if (resource === "videos") {
      if (!videoQueue) {
        store.remove("videos", record.id);
        if (existsSync(target)) unlinkSync(target);
        return reply.code(503).send({ error: "Fila de análise não inicializada" });
      }
      videoQueue.enqueue(record.id, user.organizationId);
    }
    return reply.code(201).send(store.get(resource, record.id) ?? record);
  });

  app.post("/api/v1/import/:kind", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" });
    const parsedKind = kindSchema.safeParse((request.params as { kind?: string }).kind);
    if (!parsedKind.success) return reply.code(400).send({ error: "Destino de importação inválido" });
    if (protectedKinds.includes(parsedKind.data)) return reply.code(403).send({ error: "Recurso protegido exige fluxo RKF dedicado" });
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "Selecione CSV, JSON ou FIT" });
    const buffer = await file.toBuffer();
    const extension = extname(file.filename).toLowerCase();
    const sanitize = (row: Record<string, unknown>) => {
      const { id: _id, organizationId: _organizationId, actorId: _actorId, createdAt: _createdAt, updatedAt: _updatedAt, ...safe } = row;
      return { ...canonicalizeImportRow(safe), organizationId: user!.organizationId, actorId: user!.id, importSource: file.filename };
    };
    if (extension === ".csv") {
      const rows = parseDelimited(buffer.toString("utf8"));
      if (!rows.length) return reply.code(422).send({ error: "O CSV não possui linhas importáveis" });
      return reply.code(201).send(store.importRows(parsedKind.data, rows.map(sanitize)));
    }
    if (extension === ".json") {
      try {
        const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const records = rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object").map(sanitize);
        if (!records.length) return reply.code(422).send({ error: "O JSON não contém objetos importáveis" });
        return reply.code(201).send(store.importRows(parsedKind.data, records));
      } catch (error) {
        return reply.code(422).send({ error: error instanceof Error ? `JSON inválido: ${error.message}` : "JSON inválido" });
      }
    }
    if (extension === ".xlsx") {
      try {
        const rows = await extractSpreadsheetRows(buffer);
        if (!rows.length) return reply.code(422).send({ error: "A planilha XLSX não contém linhas de dados importáveis" });
        return reply.code(201).send(store.importRows(parsedKind.data, rows.map(sanitize)));
      } catch (error) {
        return reply.code(422).send({ error: error instanceof Error ? `XLSX inválido: ${error.message}` : "XLSX inválido" });
      }
    }
    if (extension === ".zip") {
      try {
        const entries = await readSafeArchiveEntries(buffer);
        const prepared: Array<{ path: string; rows: Record<string, unknown>[] }> = [];
        for (const entry of entries) {
          if ([".zip", ".xls", ".doc", ".docx", ".pdf", ".jpg", ".jpeg", ".png", ".heic"].includes(entry.extension)) continue;
          if (entry.extension === ".csv") {
            prepared.push({ path: entry.path, rows: parseDelimited(entry.content.toString("utf8")) });
          } else if (entry.extension === ".json") {
            const parsedJson = JSON.parse(entry.content.toString("utf8")) as unknown;
            const values = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
            prepared.push({ path: entry.path, rows: values.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") });
          } else if (entry.extension === ".xlsx") {
            prepared.push({ path: entry.path, rows: await extractSpreadsheetRows(entry.content) });
          } else if (entry.extension === ".txt") {
            const text = entry.content.toString("utf8").trim();
            if (text) prepared.push({ path: entry.path, rows: [{ name: basename(entry.path), text }] });
          }
        }
        if (!prepared.some((file) => file.rows.length)) return reply.code(422).send({ error: "O ZIP não contém CSV, JSON, XLSX ou TXT importável" });
        const records: Record<string, unknown>[] = [];
        const files: Array<{ path: string; imported: number }> = [];
        for (const file of prepared) {
          if (!file.rows.length) { files.push({ path: file.path, imported: 0 }); continue; }
          const imported = store.importRows(parsedKind.data, file.rows.map((row) => sanitize({ ...row, archiveSource: file.path })));
          records.push(...imported.records);
          files.push({ path: file.path, imported: imported.imported });
        }
        return reply.code(201).send({ imported: records.length, records, archive: { totalEntries: entries.length, importedFiles: files.filter((file) => file.imported > 0).length, files } });
      } catch (error) {
        return reply.code(422).send({ error: error instanceof Error ? `ZIP inválido: ${error.message}` : "ZIP inválido" });
      }
    }
    if (extension === ".fit") {
      if (parsedKind.data !== "activities") return reply.code(422).send({ error: "Arquivos FIT devem ser importados no módulo Atividades para preservar a estrutura original." });
      const fitSdk = await import("@garmin/fitsdk") as unknown as {
        Stream: { fromBuffer: (value: Uint8Array) => unknown };
        Decoder: { new(stream: unknown): { read: () => { messages: unknown; profileVersion: unknown; errors: Error[] } }; isFIT: (stream: unknown) => boolean };
      };
      const stream = fitSdk.Stream.fromBuffer(buffer);
      if (!fitSdk.Decoder.isFIT(stream)) return reply.code(422).send({ error: "Arquivo FIT inválido" });
      const decoded = new fitSdk.Decoder(stream).read();
      const messages = decoded.messages as unknown as Record<string, unknown[]>;
      const sessions = (messages.sessionMesgs ?? []) as Record<string, unknown>[];
      const laps = (messages.lapMesgs ?? []) as Record<string, unknown>[];
      const lengths = (messages.lengthMesgs ?? []) as Record<string, unknown>[];
      const record = store.create("activities", {
        title: file.filename.replace(extension, ""), source: "fit", status: decoded.errors.length ? "imported_with_warnings" : "imported",
        profileVersion: decoded.profileVersion, session: sessions[0] ?? null, laps: laps.length, lengths: lengths.length,
        messageCounts: Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0])), errors: decoded.errors.map((error: Error) => error.message),
        organizationId: user!.organizationId, actorId: user!.id, sha256: createHash("sha256").update(buffer).digest("hex"),
      }, "import");
      const filename = `${Date.now()}-${safeName(file.filename)}`;
      writeFileSync(resolve(uploadRoot, filename), buffer);
      const updated = store.update("activities", record.id, { filename, url: `/uploads/${filename}`, sizeBytes: buffer.length });
      return reply.code(201).send({ imported: 1, records: [updated ?? record] });
    }
    return reply.code(415).send({ error: "Use arquivos CSV, JSON, XLSX, ZIP ou FIT" });
  });

  app.get("/api/v1/videos/:id/analysis", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin", "athlete"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" });
    const params = z.object({ id: z.string() }).parse(request.params);
    const record = store.get("videos", params.id);
    if (!record || record.organizationId !== user!.organizationId || (user!.role === "athlete" && !athleteMayAccess(user, String(record.athleteId ?? "")))) return reply.code(404).send({ error: "Vídeo não encontrado" });
    const job = store.list("videoAnalysisJobs").find((item) => item.videoId === params.id && ["queued", "running"].includes(String(item.status))) ?? store.list("videoAnalysisJobs").find((item) => item.videoId === params.id);
    return { video: record, job };
  });

  app.get("/api/v1/videos/:id/keyframes", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin", "athlete"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" });
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ from: z.coerce.number().nonnegative(), to: z.coerce.number().nonnegative() }).safeParse(request.query);
    if (!query.success || query.data.to < query.data.from || query.data.to - query.data.from > 30) return reply.code(400).send({ error: "Janela de poses inválida (máximo de 30 s)." });
    const record = store.get("videos", params.id);
    if (!record || record.organizationId !== user!.organizationId || (user!.role === "athlete" && !athleteMayAccess(user!, String(record.athleteId ?? "")))) return reply.code(404).send({ error: "Vídeo não encontrado" });
    const analysis = record.analysis as Record<string, unknown> | undefined;
    if (!analysis) return reply.code(404).send({ error: "Análise de vídeo não encontrada" });
    return { from: query.data.from, to: query.data.to, keyframes: keyframesInWindow(analysis, query.data.from, query.data.to) };
  });

  app.post("/api/v1/videos/:id/analyze", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" });
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ force: z.boolean().default(false) }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "Opções de análise inválidas" });
    const record = store.get("videos", params.id);
    if (!record || record.organizationId !== user!.organizationId || typeof record.filename !== "string") return reply.code(404).send({ error: "Vídeo não encontrado" });
    if (record.analysisStatus === "ready" && !body.data.force) return reply.send({ ...record, job: store.list("videoAnalysisJobs").find((item) => item.id === record.analysisJobId) });
    if (!videoQueue) return reply.code(503).send({ error: "Fila de análise não inicializada" });
    try {
      const queued = videoQueue.enqueue(params.id, user!.organizationId, body.data.force);
      return reply.code(202).send({ ...queued.video, job: queued.job });
    } catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : "Não foi possível iniciar a análise" }); }
  });

  app.post("/api/v1/videos/:id/events", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação não autorizada" : "Autenticação necessária" });
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ time: z.number().nonnegative(), category: z.string(), label: z.string().min(1), note: z.string().optional() }).safeParse(request.body);
    const record = store.get("videos", params.id);
    if (!record || record.organizationId !== user!.organizationId) return reply.code(404).send({ error: "Vídeo não encontrado" });
    if (!body.success) return reply.code(400).send({ error: "Marcador inválido" });
    const manualEvents = Array.isArray(record.manualEvents) ? record.manualEvents : [];
    return reply.code(201).send(store.update("videos", params.id, { manualEvents: [...manualEvents, { id: id("event"), ...body.data, createdAt: new Date().toISOString() }] }));
  });
}
