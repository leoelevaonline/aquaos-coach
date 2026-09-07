import { describe, expect, it } from "vitest";
import {
  MAX_VIDEO_TIMELINE_GAP_MS,
  hasNewVideoFrame,
  isVideoTimelineDiscontinuity,
} from "../pose/engine";

describe("relógio do replay", () => {
  it("não produz nova métrica enquanto o vídeo permanece pausado", () => {
    expect(hasNewVideoFrame(null, 0)).toBe(true);
    expect(hasNewVideoFrame(0, 0)).toBe(false);
    expect(isVideoTimelineDiscontinuity(0, 0)).toBe(false);
  });

  it("reinicia o histórico no seek para frente e regressivo", () => {
    expect(isVideoTimelineDiscontinuity(0, 10_000)).toBe(true);
    expect(isVideoTimelineDiscontinuity(10_000, 0)).toBe(true);
  });

  it("mantém quadros contínuos em 0,5x, 1x e 2x", () => {
    [0.5, 1, 2].forEach((playbackRate) => {
      const frameAdvanceMs = 1_000 / 30 * playbackRate;
      expect(frameAdvanceMs).toBeLessThan(MAX_VIDEO_TIMELINE_GAP_MS);
      expect(isVideoTimelineDiscontinuity(5_000, 5_000 + frameAdvanceMs)).toBe(false);
    });
  });
});
