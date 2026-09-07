/** Cliente do microservice de visão AquaVision (pose RTMO + tracking BYTE). */

const DEFAULT_TIMEOUT_MS = 900_000;

export type VisionCalibrationSnapshot = {
  origin: string;
  version: string;
  cameraId: string;
  poolId: string;
  laneIds: string[];
  coverage: number;
  validity: "valid" | "expired";
  points: Array<{ image: [number, number]; world: [number, number] }>;
};

export type MetricAvailability = { available: boolean; reliable: boolean; reason?: string };

export type VisionAnalysis = {
  engine: string;
  engineVersion: string;
  modelVersion?: string;
  methodology: string;
  analyzedAt: string;
  metadata: {
    durationSeconds: number;
    width: number;
    height: number;
    fps: number;
    sizeBytes: number;
    bitrate: number;
    units?: string;
    calibrated?: boolean;
    calibrationSnapshot?: VisionCalibrationSnapshot;
    metricAvailability?: Record<"avgSpeed" | "maxSpeed" | "distance" | "distancePerStroke", MetricAvailability>;
    persons?: number;
    primaryPersonId?: number;
    sampleFps?: number;
    keyframesTruncatedAt?: number | null;
  };
  metrics: { detectedCycles?: number; estimatedCadence?: number; rhythmConsistency?: number; meanMotion: number; peakMotion: number };
  sportMetrics?: { contractVersion: string; metrics: Array<{ id: string; status: "measured" | "unavailable" | "uncalibrated" | "not_validated"; unit: string; interval: { startSeconds: number; endSeconds: number }; coverage: number; source: string; sourceVersion: string; unavailableReason?: string; value?: number }> };
  timeline: { time: number; motion: number }[];
  events: { id: string; time: number; category: string; label: string; confidence: number; note?: string; personId?: number }[];
  people?: Array<Record<string, unknown>>;
  keyframes?: Array<{ t: number; persons: Array<{ id: number; kpts: number[][] }> }>;
  keyframeSegments?: Array<{ from: number; to: number; count: number; keyframes: Array<{ t: number; persons: Array<{ id: number; kpts: number[][] }> }> }>;
};

export type VisionStage = (progress: number, stage: string) => void;

export type VisionFallbackReason = "service_unavailable" | "request_timeout" | "network_error" | "invalid_response" | "no_people_detected" | "request_rejected";

export type VisionResult =
  | { kind: "success"; analysis: VisionAnalysis; durationMs: number }
  | { kind: "fallback"; fallbackReason: VisionFallbackReason; durationMs: number };

function visionUrl() {
  return process.env.VISION_URL ?? "http://localhost:8800";
}

function visionTimeoutMs() {
  const parsed = Number(process.env.VISION_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Solicita a análise de visão computacional para o vídeo. Qualquer falha
 * (serviço offline, timeout, nenhum atleta detectado, payload inválido)
 * devolve uma causa segura para a fila registrar o fallback sem dados brutos.
 */
export async function analyzeWithVision(filePath: string, onStage?: VisionStage, calibrationSnapshot?: VisionCalibrationSnapshot): Promise<VisionResult> {
  const startedAt = performance.now();
  const result = (fallbackReason: VisionFallbackReason): VisionResult => ({ kind: "fallback", fallbackReason, durationMs: Math.round(performance.now() - startedAt) });
  onStage?.(6, "Detectando atletas e esqueleto com RTMO");
  try {
    const response = await fetch(`${visionUrl()}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, ...(calibrationSnapshot ? { calibration: calibrationSnapshot } : {}) }),
      signal: AbortSignal.timeout(visionTimeoutMs()),
    });
    if (!response.ok) {
      if (response.status === 422) return result("no_people_detected");
      return result(response.status >= 500 ? "service_unavailable" : "request_rejected");
    }
    const payload = await response.json() as Partial<VisionAnalysis>;
    if (payload.engine !== "AquaVision" || !payload.metrics || !Array.isArray(payload.timeline) || !Array.isArray(payload.events)) return result("invalid_response");
    onStage?.(88, "Compilando métricas por atleta");
    return { kind: "success", analysis: payload as VisionAnalysis, durationMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return result(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "request_timeout" : "network_error");
  }
}
