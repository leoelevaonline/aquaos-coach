import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VideoReview } from "../modals";

const apiRequest = vi.fn();

vi.mock("../api", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  mediaUrl: (path?: string) => path,
  subscribeToLiveEvents: () => () => undefined,
  uploadFile: vi.fn(),
}));

beforeAll(() => { vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); });
afterAll(() => vi.restoreAllMocks());
afterEach(() => apiRequest.mockReset());

describe("VideoReview", () => {
  it("busca somente a janela temporal de poses do AquaVision", async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/v1/videos/video-janela/track-assignments") {
        return Promise.resolve({ assignments: [], currentByTrack: {}, athletes: [] });
      }
      if (path.includes("/keyframes?")) return Promise.resolve({ keyframes: [{ t: 0, persons: [{ id: 1, kpts: [[1, 2, .9]] }] }] });
      if (path.startsWith("/api/v1/manage/videos?")) return Promise.resolve({data:[]});
      if (path !== "/api/v1/manage/videos/video-janela") throw new Error(`Unexpected request: ${path}`);
      return Promise.resolve({
        id: "video-janela",
        analysisStatus: "ready",
        analysis: {
          engine: "AquaVision",
          metadata: { durationSeconds: 60, width: 1080, height: 608, fps: 30, sizeBytes: 1, bitrate: 1 },
          metrics: { detectedCycles: 0, estimatedCadence: 0, rhythmConsistency: 0, meanMotion: 0, peakMotion: 0 },
          timeline: [], events: [], people: [{ id: 1, strokes: 0, strokeRate: 0, rhythmConsistency: 0, avgSpeed: 0, maxSpeed: 0, distance: 0, distancePerStroke: 0, meanConfidence: .9, coverage: 100, firstSeen: 0, lastSeen: 60, durationSeconds: 60 }],
          keyframeSegments: [{ from: 0, to: 10, count: 60 }],
        },
      });
    });
    render(<VideoReview videoId="video-janela" onClose={() => undefined} onSave={() => undefined} />);
    fireEvent.click(await screen.findByRole("tab", {name:"Medições"}));
    fireEvent.click(await screen.findByLabelText("Exibir rastreamento disponível"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/v1/videos/video-janela/keyframes?from=0&to=5"));
  });
});
