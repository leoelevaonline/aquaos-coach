/**
 * Sessão de análise de pose em tempo real sobre MediaPipe BlazePose
 * (@mediapipe/tasks-vision). Encapsula a resolução de assets (local com fallback
 * para CDN), o fallback GPU→CPU, o modo VIDEO com rastreamento multiatleta e a
 * associação de trilhas. A UI só consome `process()`.
 *
 * O pacote MediaPipe é importado dinamicamente: nunca entra no bundle inicial
 * e só carrega quando o treinador inicia uma análise.
 */

import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import { PoseTracker, type Landmark, type TrackedAthlete } from "./metrics";

export type { Landmark, TrackedAthlete };

export type ModelTier = "lite" | "full" | "heavy";

export type PoseSessionOptions = {
  numPoses?: number;
  model?: ModelTier;
};

const MODEL_VERSION = "1";
const PACKAGE_VERSION = "1.0.1";

const MODEL_FILES: Record<ModelTier, string> = {
  lite: "pose_landmarker_lite.task",
  full: "pose_landmarker_full.task",
  heavy: "pose_landmarker_heavy.task",
};

function localModelUrl(model: ModelTier): string {
  return `/pose/models/${MODEL_FILES[model]}`;
}

function cdnModelUrl(model: ModelTier): string {
  return `https://storage.googleapis.com/mediapipe-models/pose_landmarker/${MODEL_FILES[model].replace(".task", "")}/float16/${MODEL_VERSION}/${MODEL_FILES[model]}`;
}

const WASM_LOCAL = "/pose/wasm";
const WASM_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${PACKAGE_VERSION}/wasm`;

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

/** Resolve assets preferindo as cópias locais geradas por prepare-vision-assets. */
export async function resolveVisionAssets(model: ModelTier): Promise<{ wasm: string; model: string }> {
  const [localModel, localWasm] = await Promise.all([reachable(localModelUrl(model)), reachable(`${WASM_LOCAL}/vision_wasm_internal.js`)]);
  return {
    wasm: localWasm ? WASM_LOCAL : WASM_CDN,
    model: localModel ? localModelUrl(model) : cdnModelUrl(model),
  };
}

export type PoseProcessResult = { time: number; athletes: TrackedAthlete[]; inferenceMs: number };

export type PoseProcessTimes = {
  mediaPipeTimeMs: number;
  videoTimeMs: number;
};

export const MAX_VIDEO_TIMELINE_GAP_MS = 1_000;

export function hasNewVideoFrame(previousVideoTimeMs: number | null, videoTimeMs: number): boolean {
  return previousVideoTimeMs === null || videoTimeMs !== previousVideoTimeMs;
}

/** Saltos invalidam a janela histórica usada pelas métricas do atleta. */
export function isVideoTimelineDiscontinuity(previousVideoTimeMs: number | null, videoTimeMs: number): boolean {
  return previousVideoTimeMs !== null
    && (videoTimeMs < previousVideoTimeMs || videoTimeMs - previousVideoTimeMs > MAX_VIDEO_TIMELINE_GAP_MS);
}

export type PoseSession = {
  /** Detecta e rastreia um novo quadro do vídeo. */
  process: (video: HTMLVideoElement, times: PoseProcessTimes) => Promise<PoseProcessResult | null>;
  reset: () => void;
  close: () => Promise<void>;
};

export async function createPoseSession(options: PoseSessionOptions = {}): Promise<PoseSession> {
  // Import dinâmico: o bundle MediaPipe só carrega no navegador quando uma
  // análise começa, fora do SSR e do bundle inicial.
  const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
  const numPoses = Math.max(1, Math.min(4, options.numPoses ?? 1));
  const model = options.model ?? "full";
  const assets = await resolveVisionAssets(model);
  const fileset = await FilesetResolver.forVisionTasks(assets.wasm);

  const build = async (delegate: "GPU" | "CPU") => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: assets.model, delegate },
    runningMode: "VIDEO",
    numPoses,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });

  let landmarker: PoseLandmarker;
  try {
    landmarker = await build("GPU");
  } catch {
    landmarker = await build("CPU");
  }

  // O grafo MediaPipe inicia na primeira inferência: o delegado GPU pode falhar
  // só nela (ex.: WebGL ausente). Aquecemos com um quadro sintético e, se o
  // grafo não subir, recriamos com CPU antes de expor a sessão.
  const warmupCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (warmupCanvas) {
    warmupCanvas.width = 64;
    warmupCanvas.height = 64;
    const warmup = async (target: PoseLandmarker) => target.detectForVideo(warmupCanvas, 1);
    try {
      warmup(landmarker);
    } catch {
      landmarker.close();
      landmarker = await build("CPU");
      warmup(landmarker);
    }
  }

  const tracker = new PoseTracker({ maxTracks: numPoses });
  let lastMediaPipeTimestamp = -1;
  let lastVideoTimeMs: number | null = null;

  return {
    async process(video, { mediaPipeTimeMs, videoTimeMs }) {
      if (video.readyState < 2 || !hasNewVideoFrame(lastVideoTimeMs, videoTimeMs)) return null;
      if (isVideoTimelineDiscontinuity(lastVideoTimeMs, videoTimeMs)) tracker.reset();
      lastVideoTimeMs = videoTimeMs;

      // O MediaPipe exige tempo crescente mesmo depois de um seek no conteúdo.
      const timestamp = Math.max(mediaPipeTimeMs, lastMediaPipeTimestamp + 0.001);
      lastMediaPipeTimestamp = timestamp;
      const started = performance.now();
      const result = landmarker.detectForVideo(video, timestamp);
      const inferenceMs = Math.round((performance.now() - started) * 10) / 10;
      const athletes = tracker.update(videoTimeMs, (result.landmarks ?? []) as Landmark[][]);
      return { time: videoTimeMs, athletes, inferenceMs };
    },
    reset() {
      tracker.reset();
      lastVideoTimeMs = null;
    },
    async close() {
      tracker.reset();
      landmarker.close();
    },
  };
}
