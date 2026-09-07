/** Cliente do microservice de visão AquaVision (pose RTMO + tracking BYTE). */

const DEFAULT_TIMEOUT_MS = 900_000;

export type VisionAnalysis = {
  engine: string;
  engineVersion: string;
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
    persons?: number;
    primaryPersonId?: number;
    sampleFps?: number;
    keyframesTruncatedAt?: number | null;
  };
  metrics: { detectedCycles: number; estimatedCadence: number; rhythmConsistency: number; meanMotion: number; peakMotion: number };
  timeline: { time: number; motion: number }[];
  events: { id: string; time: number; category: string; label: string; confidence: number; note?: string; personId?: number }[];
  people?: Array<Record<string, unknown>>;
  keyframes?: Array<{ t: number; persons: Array<{ id: number; kpts: number[][] }> }>;
};

export type VisionStage = (progress: number, stage: string) => void;

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
 * devolve `undefined` para a fila cair no AquaMotion local sem duplicar lógica.
 */
export async function analyzeWithVision(filePath: string, onStage?: VisionStage): Promise<VisionAnalysis | undefined> {
  onStage?.(6, "Detectando atletas e esqueleto com RTMO");
  try {
    const response = await fetch(`${visionUrl()}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
      signal: AbortSignal.timeout(visionTimeoutMs()),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as Partial<VisionAnalysis>;
    if (payload.engine !== "AquaVision" || !payload.metrics || !Array.isArray(payload.timeline) || !Array.isArray(payload.events)) return undefined;
    onStage?.(88, "Compilando métricas por atleta");
    return payload as VisionAnalysis;
  } catch {
    return undefined;
  }
}
