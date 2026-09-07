import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedStore } from "./managed-store.js";
import { registerOperationalRoutes } from "./operational-routes.js";
import { login } from "./auth.js";
import JSZip from "jszip";
import ExcelJS from "exceljs";

const root = mkdtempSync(join(tmpdir(), "rkf-operational-"));
const store = new ManagedStore(join(root, "store.json"));
const app = Fastify({ logger: false });
await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
registerOperationalRoutes(app, store);
const cookie = `natacao_session=${(await login("coach@natacao.local", "natacao-demo"))!.token}`;

function form(filename: string, mimeType: string, content: string | Buffer) {
  const boundary = `----rkf-${Date.now().toString(36)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => app.ready());
afterAll(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

describe("uploads e importações operacionais", () => {
  it("entrega poses paginadas por janela sem enviar toda a evidência ao cliente", async () => {
    const video = store.create("videos", {
      id: "video-paginado",
      organizationId: "org-demo",
      athleteId: "ath-ana",
      analysis: {
        engine: "AquaVision",
        keyframeSegments: [
          { from: 0, to: 10, count: 2, keyframes: [{ t: 1, persons: [{ id: 1, kpts: [[1, 2, .9]] }] }, { t: 9, persons: [{ id: 1, kpts: [[3, 4, .9]] }] }] },
          { from: 10, to: 20, count: 1, keyframes: [{ t: 12, persons: [{ id: 7, kpts: [[5, 6, .9]] }] }] },
        ],
      },
    });
    const summary = await app.inject({ method: "GET", url: `/api/v1/manage/videos/${video.id}`, headers: { cookie } });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().analysis.keyframes).toBeUndefined();
    expect(summary.json().analysis.keyframeSegments).toEqual([{ from: 0, to: 10, count: 2 }, { from: 10, to: 20, count: 1 }]);

    const window = await app.inject({ method: "GET", url: `/api/v1/videos/${video.id}/keyframes?from=8&to=13`, headers: { cookie } });
    expect(window.statusCode).toBe(200);
    expect(window.json().keyframes.map((frame: { t: number }) => frame.t)).toEqual([9, 12]);
    expect((await app.inject({ method: "GET", url: `/api/v1/videos/${video.id}/keyframes?from=0&to=31`, headers: { cookie } })).statusCode).toBe(400);
  });

  it("preserva documento, extrai conteúdo e injeta organização/ator", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/uploads?kind=documents&title=Plano%20A2", ...form("plano-a2.txt", "text/plain", "8x100 livre A2") });
    expect(response.statusCode).toBe(201);
    const document = response.json();
    expect(document).toMatchObject({ organizationId: "org-demo", actorId: "user-coach", extractionStatus: "extracted", extraction: { text: "8x100 livre A2" } });
    expect(document.sha256).toHaveLength(64);
    const listed = await app.inject({ method: "GET", url: "/api/v1/manage/documents", headers: { cookie } });
    expect(listed.json().data.some((item: { id: string }) => item.id === document.id)).toBe(true);
    const removed = await app.inject({ method: "DELETE", url: `/api/v1/manage/documents/${document.id}`, headers: { cookie } });
    expect(removed.statusCode).toBe(200);
  });

  it("neutraliza tenant e identidade vindos de CSV", async () => {
    const csv = "name,organizationId,actorId\nVelocistas,org-invasora,ator-falso";
    const response = await app.inject({ method: "POST", url: "/api/v1/import/groups", ...form("grupos.csv", "text/csv", csv) });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ imported: 1, records: [{ name: "Velocistas", organizationId: "org-demo", actorId: "user-coach" }] });
  });

  it("bloqueia listagem sem sessão", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/manage/videos" })).statusCode).toBe(401);
  });

  it("aceita ZIP documental seguro e persiste o relatório de extração", async () => {
    const zip = new JSZip();
    zip.file("biblioteca/sessao.txt", "8x100 livre A2");
    const payload = await zip.generateAsync({ type: "nodebuffer" });
    const response = await app.inject({ method: "POST", url: "/api/v1/uploads?kind=documents", ...form("biblioteca-rkf.zip", "application/zip", payload) });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      extractionStatus: "extracted",
      extraction: { format: "zip", archive: { totalEntries: 1, extractedEntries: 1 } },
    });
    await app.inject({ method: "DELETE", url: `/api/v1/manage/documents/${response.json().id}`, headers: { cookie } });
  });

  it("importa XLSX diretamente e ZIP com CSV sem perder a origem da aba/arquivo", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Atletas");
    sheet.addRow(["name", "status"]); sheet.addRow(["Nadador XLSX", "active"]);
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
    const direct = await app.inject({ method: "POST", url: "/api/v1/import/athletes", ...form("atletas.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsx) });
    expect(direct.statusCode).toBe(201);
    expect(direct.json()).toMatchObject({ imported: 1, records: [{ name: "Nadador XLSX", __sheet: "Atletas", organizationId: "org-demo" }] });

    const zip = new JSZip();
    zip.file("dados/atletas.csv", "name,status\nNadador ZIP,active");
    zip.file("dados/notas.txt", "origem=zip");
    const zipped = await app.inject({ method: "POST", url: "/api/v1/import/athletes", ...form("atletas.zip", "application/zip", await zip.generateAsync({ type: "nodebuffer" })) });
    expect(zipped.statusCode).toBe(201);
    expect(zipped.json()).toMatchObject({ imported: 2, archive: { importedFiles: 2 } });
    expect(zipped.json().records).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Nadador ZIP", archiveSource: "dados/atletas.csv" }),
      expect.objectContaining({ name: "notas.txt", archiveSource: "dados/notas.txt" }),
    ]));
  });
});
