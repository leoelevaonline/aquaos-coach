import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedStore } from "./managed-store.js";
import { buildLiveWindowContext, buildVisionCoachContext, registerAiRoutes, VISION_COACH_PROMPT, type VisionAnalysisRecord } from "./ai-routes.js";
import { login } from "./auth.js";

const root = mkdtempSync(join(tmpdir(), "rkf-vision-coach-"));
const store = new ManagedStore(join(root, "store.json"));
const app = Fastify({ logger: false });
registerAiRoutes(app, store);
const cookie = `natacao_session=${(await login("coach@natacao.local", "natacao-demo"))!.token}`;

const kpts = (x: number, y: number, score = 0.9): number[][] => Array.from({ length: 17 }, () => [x, y, score]);

const analysis: VisionAnalysisRecord = {
  engine: "AquaVision",
  engineVersion: "1.0",
  metadata: { durationSeconds: 10, width: 608, height: 1080, fps: 59.94, units: "px", calibrated: false, persons: 1, primaryPersonId: 7, sampleFps: 12 },
  metrics: { detectedCycles: 9, estimatedCadence: 58, rhythmConsistency: 91, meanMotion: 40, peakMotion: 100 },
  timeline: Array.from({ length: 20 }, (_, index) => ({ time: index * 0.5, motion: 30 + (index % 5) * 10 })),
  events: Array.from({ length: 9 }, (_, index) => ({ id: `stroke-7-${index + 1}`, time: 1 + index, category: "stroke", label: `Braçada ${index + 1} · Atleta #7`, confidence: 88, personId: 7 })),
  people: [{
    id: 7, idAliases: [9], firstSeen: 0, lastSeen: 9.9, durationSeconds: 9.9, strokes: 9, strokeRate: 58, rhythmConsistency: 91,
    avgSpeed: 26.5, maxSpeed: 54.8, distance: 262, distancePerStroke: 29.1, units: "px",
    gaps: [{ from: 6.1, to: 7.4 }],
    validity: { strokes: "measured", strokeRate: "measured", rhythmConsistency: "measured", avgSpeed: "uncalibrated", maxSpeed: "uncalibrated", distance: "uncalibrated", distancePerStroke: "uncalibrated" },
    meanConfidence: 0.81, coverage: 87.5, strokeSignal: "punho esq. (y)", strokeTimes: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  }],
  keyframes: [
    { t: 0, persons: [{ id: 7, kpts: kpts(100, 200) }] },
    { t: 0.5, persons: [{ id: 7, kpts: kpts(120, 205) }] },
    { t: 4, persons: [{ id: 7, kpts: kpts(200, 240) }] },
    { t: 4.5, persons: [{ id: 7, kpts: kpts(220, 245) }] },
  ],
};

store.create("videos", { id: "video-coach", organizationId: "org-demo", title: "Treino técnico diurno", analysis });
store.create("videos", { id: "video-sem-analise", organizationId: "org-demo", title: "Sem análise" });
store.create("videos", { id: "video-outro", organizationId: "org-outro", title: "Outra organização", analysis });

beforeAll(async () => app.ready());
afterAll(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

describe("prompt do treinador de seleção", () => {
  it("define identidade, regras de evidência e limite humano", () => {
    expect(VISION_COACH_PROMPT).toContain("seleção nacional de natação");
    expect(VISION_COACH_PROMPT).toContain("Nunca invente");
    expect(VISION_COACH_PROMPT).toContain("decisão final é sempre do treinador humano");
  });
});

describe("buildVisionCoachContext", () => {
  it("serializa vídeo inteiro: atletas, braçadas, perfil de movimento", () => {
    const context = buildVisionCoachContext(analysis, "Treino técnico diurno");
    expect(context).toContain("Treino técnico diurno");
    expect(context).toContain("Atleta #7");
    expect(context).toContain("cadência 58/min");
    expect(context).toContain("sem calibração (unidades: px - velocidades e distâncias NÃO são metros)");
    expect(context).toContain("braçadas em: 1s, 2s, 3s");
    expect(context).toContain("PERFIL DE MOVIMENTO AO LONGO DO VÍDEO");
    expect(context).toContain("EVENTOS DE BRAÇADA (9)");
    expect(context).toContain("1 lacuna(s) sem rastreio: 6.1-7.4s");
    expect(context).toContain("velocidade média 26.5 px/s (sem calibração: pixels, não metros)");
    expect(context).not.toContain("índice técnico");
  });

  it("declara métricas não medidas em vez de preencher com zero", () => {
    const unmeasured: VisionAnalysisRecord = {
      ...analysis,
      metrics: { detectedCycles: 1, estimatedCadence: 0, rhythmConsistency: 0, meanMotion: 20, peakMotion: 60 },
      people: [{ ...analysis.people![0], strokes: 1, strokeRate: 0, rhythmConsistency: 0, distancePerStroke: 0, validity: { ...analysis.people![0].validity, strokeRate: "unavailable", rhythmConsistency: "unavailable", distancePerStroke: "unavailable" } }],
    };
    const context = buildVisionCoachContext(unmeasured, "Curto");
    expect(context).toContain("cadência não medido");
    expect(context).toContain("distância por braçada não medido");
    expect(context).not.toContain("cadência 0/min");
    expect(VISION_COACH_PROMPT).toContain("não medido");
  });

  it("declara métricas esportivas não validadas e não expõe números legados", () => {
    const gated: VisionAnalysisRecord = { ...analysis, sportMetrics: { contractVersion: "sports-metrics/v1", metrics: [{ id: "cadence", label: "cadência", status: "not_validated", unit: "cycles/min", interval: { startSeconds: 0, endSeconds: 10 }, coverage: 87.5, source: "AquaVision", sourceVersion: "1.1", unavailableReason: "Extrator não validado." }] } };
    const context = buildVisionCoachContext(gated, "Gated");
    expect(context).toContain("cadência: indisponível (not_validated: Extrator não validado.)");
    expect(context).not.toContain("cadência 58/min");
    expect(VISION_COACH_PROMPT).toContain("não validado");
  });

  it("limita o que a IA pode afirmar sobre o AquaMotion", () => {
    const context = buildVisionCoachContext({ engine: "AquaMotion", engineVersion: "1.1-beta", metadata: { durationSeconds: 12 }, metrics: { detectedCycles: 4 }, timeline: [{ time: 0, motion: 10 }] }, "Fallback");
    expect(context).toContain("LIMITE DO MOTOR: AquaMotion");
    expect(context).toContain("nenhum - o rastreamento não encontrou atletas");
  });

  it("declara ausência de atletas com honestidade", () => {
    const context = buildVisionCoachContext({ engine: "AquaVision", metadata: {} }, "Vazio");
    expect(context).toContain("nenhum - o rastreamento não encontrou atletas");
  });
});

describe("buildLiveWindowContext", () => {
  it("destaca atletas no quadro e braçadas da janela, sem antecipar o futuro", () => {
    const context = buildLiveWindowContext(analysis, 4.2, 4);
    expect(context).toContain("INSTANTE ATUAL: t = 4.2 s");
    expect(context).toContain("Atleta #7");
    expect(context).toContain("BRAÇADAS NESTA JANELA: 1.0s (#7), 2.0s (#7), 3.0s (#7), 4.0s (#7)");
    expect(context).not.toContain("5.0s");
    expect(context).toContain("deslocamento estimado");
    expect(context).toContain("pixels da imagem, não em metros");
  });

  it("informa quando ninguém tem pose confiável na janela", () => {
    const context = buildLiveWindowContext(analysis, 8.5, 2);
    expect(context).toContain("nenhum com pose confiável nesta janela");
    expect(context).toContain("BRAÇADAS NESTA JANELA: 7.0s (#7), 8.0s (#7)");
  });

  it("avisa quando a janela ultrapassa a cobertura dos keyframes", () => {
    const context = buildLiveWindowContext({ ...analysis, metadata: { ...analysis.metadata, keyframesTruncatedAt: 5 } }, 9, 2);
    expect(context).toContain("a pose sincronizada não cobre este trecho");
  });
});

describe("rotas do treinador de visão", () => {
  it("exige autenticação de comissão técnica", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/ai/vision-coach/report", payload: { videoId: "video-coach" } });
    expect(response.statusCode).toBe(401);
  });

  it("valida vídeo e análise antes de chamar o modelo", async () => {
    const missing = await app.inject({ method: "POST", url: "/api/v1/ai/vision-coach/report", headers: { cookie }, payload: {} });
    expect(missing.statusCode).toBe(400);
    const unknown = await app.inject({ method: "POST", url: "/api/v1/ai/vision-coach/report", headers: { cookie }, payload: { videoId: "sumiu" } });
    expect(unknown.statusCode).toBe(404);
    const otherOrg = await app.inject({ method: "POST", url: "/api/v1/ai/vision-coach/report", headers: { cookie }, payload: { videoId: "video-outro" } });
    expect(otherOrg.statusCode).toBe(404);
    const noAnalysis = await app.inject({ method: "POST", url: "/api/v1/ai/vision-coach/report", headers: { cookie }, payload: { videoId: "video-sem-analise" } });
    expect(noAnalysis.statusCode).toBe(422);
  });

  it("responde 503 claro sem LLM_API_KEY no ambiente", async () => {
    const report = await app.inject({ method: "POST", url: "/api/v1/ai/vision-coach/report", headers: { cookie }, payload: { videoId: "video-coach" } });
    expect(report.statusCode).toBe(503);
    expect(report.json().error).toContain("LLM_API_KEY");
    const live = await app.inject({ method: "POST", url: "/api/v1/ai/vision-coach/live", headers: { cookie }, payload: { videoId: "video-coach", currentTime: 4.2, windowSeconds: 4 } });
    expect(live.statusCode).toBe(503);
  });

  it("valida instante e janela da análise ao vivo", async () => {
    const badTime = await app.inject({ method: "POST", url: "/api/v1/ai/vision-coach/live", headers: { cookie }, payload: { videoId: "video-coach", currentTime: -1, windowSeconds: 4 } });
    expect(badTime.statusCode).toBe(400);
    const badWindow = await app.inject({ method: "POST", url: "/api/v1/ai/vision-coach/live", headers: { cookie }, payload: { videoId: "video-coach", currentTime: 4, windowSeconds: 30 } });
    expect(badWindow.statusCode).toBe(400);
  });
});
