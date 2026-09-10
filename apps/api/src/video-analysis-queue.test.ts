import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./vision-client.js", () => ({ analyzeWithVision: vi.fn() }));
vi.mock("./video-analysis.js", () => ({ analyzeVideo: vi.fn(), generateThumbnail: vi.fn() }));

import { ManagedStore } from "./managed-store.js";
import { analyzeVideo } from "./video-analysis.js";
import { VideoAnalysisQueue } from "./video-analysis-queue.js";
import { analyzeWithVision, type VisionCalibrationSnapshot } from "./vision-client.js";

const analyzeWithVisionMock = vi.mocked(analyzeWithVision);
const analyzeVideoMock = vi.mocked(analyzeVideo);
const directories: string[] = [];

const fallbackAnalysis = {
  engine: "AquaMotion",
  engineVersion: "1.1-beta",
  analyzedAt: "2026-09-07T00:00:00.000Z",
  methodology: "Movimento global",
  metadata: { durationSeconds: 10, width: 100, height: 100, fps: 30, sizeBytes: 100, bitrate: 80 },
  metrics: { detectedCycles: 1, estimatedCadence: 0, rhythmConsistency: 0, meanMotion: 20, peakMotion: 30 },
  timeline: [],
  events: [],
};

function makeCalibration(): VisionCalibrationSnapshot {
  return {
    origin: "calibração técnica",
    version: "2026.09.1",
    cameraId: "camera-fixa-1",
    poolId: "piscina-olimpica",
    laneIds: ["4"],
    coverage: 0.9,
    validity: "valid",
    points: [
      { image: [0, 0], world: [0, 0] },
      { image: [400, 0], world: [25, 0] },
      { image: [400, 200], world: [25, 12.5] },
      { image: [0, 200], world: [0, 12.5] },
    ],
  };
}

function createQueue(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  directories.push(root);
  const store = new ManagedStore(join(root, "store.json"));
  return { root, store, queue: new VideoAnalysisQueue(store, join(root, "uploads")) };
}

afterEach(() => {
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("VideoAnalysisQueue", () => {
  it.each(["completed", "failed"] as const)("preserva a revisão salva durante o processamento quando o job termina %s", async (outcome) => {
    const { root, store, queue } = createQueue("aquaos-video-review-");
    const video = store.create("videos", { filename: "treino.mp4", organizationId: "org-demo", status: "ready" });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    analyzeWithVisionMock.mockResolvedValue({ kind: "fallback", fallbackReason: "service_unavailable", durationMs: 123 });
    analyzeVideoMock.mockImplementation(async (_path, _thumbnail, progress) => {
      await pending;
      await progress?.(78, "Calculando periodicidade do movimento");
      expect(store.get("videos", video.id)?.status).toBe("reviewed");
      if (outcome === "failed") throw new Error("Falha no motor");
      return fallbackAnalysis;
    });

    const { job } = queue.enqueue(video.id, "org-demo");
    await vi.waitFor(() => expect(analyzeVideoMock).toHaveBeenCalledOnce());
    expect(store.get("videos", video.id)?.status).toBe("processing");
    const review = {
      status: "reviewed",
      feedback: "Manter alinhamento na saída da virada.",
      coachReview: { version: 2, drawings: [{ id: "drawing-1", time: 2, type: "line", points: [[0.1, 0.2], [0.3, 0.4]] }], voice: [] },
      manualEvents: [{ id: "marker-1", time: 2, category: "turn", label: "Virada" }],
      reviewedAt: "2026-09-10T10:00:00.000Z",
    };
    store.update("videos", video.id, review);
    finish();

    await vi.waitFor(() => expect(store.get("videoAnalysisJobs", job.id)?.status).toBe(outcome));
    expect(store.get("videos", video.id)).toMatchObject({ ...review, analysisStatus: outcome === "completed" ? "ready" : "failed" });
    expect(new ManagedStore(join(root, "store.json")).get("videos", video.id)).toMatchObject(review);
  });

  it("mantém o estado revisado ao enfileirar e concluir uma nova análise", async () => {
    const { store, queue } = createQueue("aquaos-video-reviewed-retry-");
    const video = store.create("videos", { filename: "treino.mp4", organizationId: "org-demo", status: "reviewed", feedback: "Revisão aprovada" });
    analyzeWithVisionMock.mockImplementation(async (_path, progress) => {
      await progress?.(60, "Analisando movimento");
      expect(store.get("videos", video.id)?.status).toBe("reviewed");
      return { kind: "fallback", fallbackReason: "service_unavailable", durationMs: 123 };
    });
    analyzeVideoMock.mockResolvedValue(fallbackAnalysis);

    const { job, video: queuedVideo } = queue.enqueue(video.id, "org-demo", true);
    expect(queuedVideo.status).toBe("reviewed");
    await vi.waitFor(() => expect(store.get("videoAnalysisJobs", job.id)?.status).toBe("completed"));
    expect(store.get("videos", video.id)).toMatchObject({ status: "reviewed", feedback: "Revisão aprovada", analysisStatus: "ready" });
  });

  it("persiste a tentativa de fallback sem caminho nem resposta bruta", async () => {
    const { store, queue } = createQueue("aquaos-vision-observability-");
    const job = store.create("videoAnalysisJobs", { id: "job-vision", videoId: "video-vision", organizationId: "org-demo", status: "queued", progress: 0, stage: "Aguardando" });
    store.create("videos", { id: "video-vision", filename: "treino.mp4", organizationId: "org-demo" });
    analyzeWithVisionMock.mockResolvedValue({ kind: "fallback", fallbackReason: "service_unavailable", durationMs: 123 });
    analyzeVideoMock.mockResolvedValue(fallbackAnalysis);

    await (queue as any).process(job.id);

    const persisted = store.get("videoAnalysisJobs", job.id)!;
    expect(persisted).toMatchObject({ engine: "AquaMotion", engineVersion: "1.1-beta", fallbackReason: "service_unavailable" });
    expect(persisted.visionAttempts).toEqual([expect.objectContaining({ engine: "AquaVision", outcome: "fallback", durationMs: 123, fallbackReason: "service_unavailable" })]);
    expect(JSON.stringify(persisted)).not.toContain("treino.mp4");
  });

  it("persiste versões do motor e modelo quando o AquaVision responde", async () => {
    const { store, queue } = createQueue("aquaos-vision-observability-");
    const job = store.create("videoAnalysisJobs", { id: "job-vision-success", videoId: "video-vision-success", organizationId: "org-demo", status: "queued", progress: 0, stage: "Aguardando" });
    store.create("videos", { id: "video-vision-success", filename: "treino.mp4", organizationId: "org-demo" });
    analyzeWithVisionMock.mockResolvedValue({ kind: "success", durationMs: 456, analysis: {
      engine: "AquaVision", engineVersion: "1.0", modelVersion: "RTMO balanced + RTMPose balanced", analyzedAt: "2026-09-07T00:00:00.000Z", methodology: "Pose",
      metadata: { durationSeconds: 10, width: 100, height: 100, fps: 30, sizeBytes: 100, bitrate: 80 }, metrics: { meanMotion: 20, peakMotion: 30 }, timeline: [], events: [],
    } });

    await (queue as any).process(job.id);

    expect(store.get("videoAnalysisJobs", job.id)).toMatchObject({ engine: "AquaVision", engineVersion: "1.0", modelVersion: "RTMO balanced + RTMPose balanced", visionAttempts: [expect.objectContaining({ outcome: "success", durationMs: 456 })] });
  });

  it("persiste e envia um snapshot imutável da calibração", async () => {
    const { store, queue } = createQueue("aquaos-calibration-");
    const video = store.create("videos", { filename: "treino.mp4", organizationId: "org-demo" });
    const calibration = makeCalibration();
    analyzeWithVisionMock.mockResolvedValue({ kind: "fallback", fallbackReason: "service_unavailable", durationMs: 123 });
    analyzeVideoMock.mockResolvedValue(fallbackAnalysis);

    const { job } = queue.enqueue(video.id, "org-demo", true, calibration);
    calibration.laneIds.push("5");

    expect(store.get("videoAnalysisJobs", job.id)?.calibrationSnapshot).toMatchObject({ version: "2026.09.1", laneIds: ["4"] });
    await vi.waitFor(() => expect(store.get("videoAnalysisJobs", job.id)?.status).toBe("completed"));
    expect(analyzeWithVisionMock).toHaveBeenCalledWith(expect.any(String), expect.any(Function), expect.objectContaining({ laneIds: ["4"] }));
    expect(store.get("videos", video.id)?.analysisCalibrationSnapshot).toMatchObject({ version: "2026.09.1", laneIds: ["4"] });
  });
});
