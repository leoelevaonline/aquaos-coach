import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./vision-client.js", () => ({ analyzeWithVision: vi.fn() }));
vi.mock("./video-analysis.js", () => ({ analyzeVideo: vi.fn(), generateThumbnail: vi.fn() }));

import { ManagedStore } from "./managed-store.js";
import { VideoAnalysisQueue } from "./video-analysis-queue.js";
import { analyzeVideo } from "./video-analysis.js";
import { analyzeWithVision } from "./vision-client.js";

const analyzeWithVisionMock = vi.mocked(analyzeWithVision);
const analyzeVideoMock = vi.mocked(analyzeVideo);

afterEach(() => vi.resetAllMocks());

describe("VideoAnalysisQueue", () => {
  it("persiste a tentativa de fallback sem caminho nem resposta bruta", async () => {
    const root = mkdtempSync(join(tmpdir(), "aquaos-vision-observability-"));
    const store = new ManagedStore(join(root, "store.json"));
    const queue = new VideoAnalysisQueue(store, join(root, "uploads"));
    const job = store.create("videoAnalysisJobs", { id: "job-vision", videoId: "video-vision", organizationId: "org-demo", status: "queued", progress: 0, stage: "Aguardando" });
    store.create("videos", { id: "video-vision", filename: "treino.mp4", organizationId: "org-demo" });
    analyzeWithVisionMock.mockResolvedValue({ kind: "fallback", fallbackReason: "service_unavailable", durationMs: 123 });
    analyzeVideoMock.mockResolvedValue({
      engine: "AquaMotion", engineVersion: "1.1-beta", analyzedAt: "2026-09-07T00:00:00.000Z", methodology: "Movimento global",
      metadata: { durationSeconds: 10, width: 100, height: 100, fps: 30, sizeBytes: 100, bitrate: 80 }, metrics: { detectedCycles: 1, estimatedCadence: 0, rhythmConsistency: 0, meanMotion: 20, peakMotion: 30 }, timeline: [], events: [],
    });

    await (queue as any).process(job.id);

    const persisted = store.get("videoAnalysisJobs", job.id)!;
    expect(persisted).toMatchObject({ engine: "AquaMotion", engineVersion: "1.1-beta", fallbackReason: "service_unavailable" });
    expect(persisted.visionAttempts).toEqual([expect.objectContaining({ engine: "AquaVision", outcome: "fallback", durationMs: 123, fallbackReason: "service_unavailable" })]);
    expect(JSON.stringify(persisted)).not.toContain("treino.mp4");
    rmSync(root, { recursive: true, force: true });
  });

  it("persiste versões do motor e modelo quando o AquaVision responde", async () => {
    const root = mkdtempSync(join(tmpdir(), "aquaos-vision-observability-"));
    const store = new ManagedStore(join(root, "store.json"));
    const queue = new VideoAnalysisQueue(store, join(root, "uploads"));
    const job = store.create("videoAnalysisJobs", { id: "job-vision-success", videoId: "video-vision-success", organizationId: "org-demo", status: "queued", progress: 0, stage: "Aguardando" });
    store.create("videos", { id: "video-vision-success", filename: "treino.mp4", organizationId: "org-demo" });
    analyzeWithVisionMock.mockResolvedValue({ kind: "success", durationMs: 456, analysis: {
      engine: "AquaVision", engineVersion: "1.0", modelVersion: "RTMO balanced + RTMPose balanced", analyzedAt: "2026-09-07T00:00:00.000Z", methodology: "Pose",
      metadata: { durationSeconds: 10, width: 100, height: 100, fps: 30, sizeBytes: 100, bitrate: 80 }, metrics: { detectedCycles: 1, estimatedCadence: 10, rhythmConsistency: 90, meanMotion: 20, peakMotion: 30 }, timeline: [], events: [],
    } });

    await (queue as any).process(job.id);

    expect(store.get("videoAnalysisJobs", job.id)).toMatchObject({ engine: "AquaVision", engineVersion: "1.0", modelVersion: "RTMO balanced + RTMPose balanced", visionAttempts: [expect.objectContaining({ outcome: "success", durationMs: 456 })] });
    rmSync(root, { recursive: true, force: true });
  });
});
