import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeWithVision, type VisionAnalysis } from "./vision-client.js";

const validAnalysis = {
  engine: "AquaVision",
  engineVersion: "1.0",
  methodology: "pose",
  analyzedAt: "2026-09-03T00:00:00.000Z",
  metadata: { durationSeconds: 10, width: 1080, height: 608, fps: 59.94, sizeBytes: 1024, bitrate: 8000 },
  metrics: { detectedCycles: 10, estimatedCadence: 60, rhythmConsistency: 95, meanMotion: 40, peakMotion: 100 },
  timeline: [{ time: 0, motion: 10 }],
  events: [{ id: "stroke-1", time: 1, category: "stroke", label: "Braçada 1", confidence: 90 }],
  people: [{ id: 1, strokes: 10 }],
} as VisionAnalysis;

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("vision client", () => {
  it("envia o caminho absoluto e devolve a análise válida", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(validAnalysis));
    vi.stubGlobal("fetch", fetchMock);
    const stages: Array<[number, string]> = [];
    const result = await analyzeWithVision("/uploads/treino.mp4", (progress, stage) => stages.push([progress, stage]));
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.analysis.metrics.detectedCycles).toBe(10);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/analyze");
    expect(JSON.parse(String(init.body)).path).toBe("/uploads/treino.mp4");
    expect(stages.map(([_, stage]) => stage)).toEqual(["Detectando atletas e esqueleto com RTMO", "Compilando métricas por atleta"]);
  });

  it("retorna fallback seguro quando o serviço está indisponível (503)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: "modelo não carregado" }, 503)));
    await expect(analyzeWithVision("/uploads/treino.mp4")).resolves.toMatchObject({ kind: "fallback", fallbackReason: "service_unavailable" });
  });

  it("retorna fallback seguro quando nenhum atleta é detectado (422)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: "nenhum atleta" }, 422)));
    await expect(analyzeWithVision("/uploads/treino.mp4")).resolves.toMatchObject({ kind: "fallback", fallbackReason: "no_people_detected" });
  });

  it("retorna fallback seguro em erro de rede", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(analyzeWithVision("/uploads/treino.mp4")).resolves.toMatchObject({ kind: "fallback", fallbackReason: "network_error" });
  });

  it("rejeita payload de outro motor ou malformado", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engine: "AquaMotion", metrics: {} })));
    await expect(analyzeWithVision("/uploads/treino.mp4")).resolves.toMatchObject({ kind: "fallback", fallbackReason: "invalid_response" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engine: "AquaVision" })));
    await expect(analyzeWithVision("/uploads/treino.mp4")).resolves.toMatchObject({ kind: "fallback", fallbackReason: "invalid_response" });
  });

  it("usa a VISION_URL configurada", async () => {
    vi.stubEnv("VISION_URL", "http://vision:8800");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(validAnalysis));
    vi.stubGlobal("fetch", fetchMock);
    await analyzeWithVision("/uploads/treino.mp4");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://vision:8800/analyze");
  });
});
