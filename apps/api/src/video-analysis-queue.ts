import { extname, resolve } from "node:path";
import type { ManagedRecord, ManagedStore } from "./managed-store.js";
import { analyzeVideo, generateThumbnail } from "./video-analysis.js";
import { analyzeWithVision, type VisionAnalysis, type VisionFallbackReason } from "./vision-client.js";

type VideoJob = ManagedRecord & {
  videoId: string;
  organizationId: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  stage: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

type VideoRecord = ManagedRecord & {
  filename?: string;
  analysisStatus?: string;
  analysisJobId?: string;
};

type VisionAttempt = {
  attemptedAt: string;
  durationMs: number;
  outcome: "success" | "fallback";
  engine: "AquaVision";
  engineVersion?: string;
  modelVersion?: string;
  fallbackReason?: VisionFallbackReason;
};

const now = () => new Date().toISOString();

/**
 * Fila local, serializada e persistida como recurso gerenciável. O processamento
 * continua fora da requisição HTTP, enquanto o ManagedStore transmite cada
 * estágio por SSE para o treinador.
 */
export class VideoAnalysisQueue {
  private readonly pending: string[] = [];
  private running = false;

  constructor(private readonly store: ManagedStore, private readonly uploadRoot: string) {}

  resume() {
    for (const record of this.store.list("videoAnalysisJobs") as VideoJob[]) {
      if (record.status !== "queued" && record.status !== "running") continue;
      if (record.status === "running") this.store.update("videoAnalysisJobs", record.id, { status: "queued", stage: "Retomando análise após reinício" });
      if (!this.pending.includes(record.id)) this.pending.push(record.id);
    }
    void this.drain();
  }

  enqueue(videoId: string, organizationId: string, force = false) {
    const video = this.store.get("videos", videoId) as VideoRecord | undefined;
    if (!video || video.organizationId !== organizationId || typeof video.filename !== "string") throw new Error("Vídeo não encontrado");

    const current = (this.store.list("videoAnalysisJobs") as VideoJob[]).find((job) => job.videoId === videoId && (job.status === "queued" || job.status === "running"));
    if (current && !force) return { video, job: current };

    const job = this.store.create("videoAnalysisJobs", {
      videoId,
      organizationId,
      status: "queued",
      progress: 0,
      stage: "Aguardando processamento",
      requestedAt: now(),
    }) as VideoJob;
    this.store.update("videos", videoId, {
      status: "processing",
      analysisStatus: "queued",
      analysisProgress: 0,
      analysisStage: "Aguardando processamento",
      analysisJobId: job.id,
      ...(force ? { analysisError: undefined } : {}),
    });
    this.pending.push(job.id);
    void this.drain();
    return { video: this.store.get("videos", videoId) as VideoRecord, job };
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const jobId = this.pending.shift();
        if (jobId) await this.process(jobId);
      }
    } finally {
      this.running = false;
    }
  }

  private async process(jobId: string) {
    const job = this.store.get("videoAnalysisJobs", jobId) as VideoJob | undefined;
    if (!job) return;
    const video = this.store.get("videos", job.videoId) as VideoRecord | undefined;
    if (!video || typeof video.filename !== "string") {
      this.store.update("videoAnalysisJobs", job.id, { status: "failed", progress: 0, stage: "Vídeo não encontrado", error: "Vídeo não encontrado", completedAt: now() });
      return;
    }

    const updateProgress = (progress: number, stage: string) => {
      this.store.update("videoAnalysisJobs", job.id, { status: "running", progress, stage, startedAt: job.startedAt ?? now() });
      this.store.update("videos", video.id, { status: "processing", analysisStatus: "processing", analysisProgress: progress, analysisStage: stage, analysisJobId: job.id });
    };

    try {
      const videoPath = resolve(this.uploadRoot, video.filename);
      const thumbnail = `${video.filename.replace(extname(video.filename), "")}-thumb.jpg`;
      const thumbnailPath = resolve(this.uploadRoot, thumbnail);
      updateProgress(2, "Consultando motor de visão AquaVision");
      const vision = await analyzeWithVision(videoPath, updateProgress);
      const visionAttempt: VisionAttempt = vision.kind === "success"
        ? { attemptedAt: now(), durationMs: vision.durationMs, outcome: "success", engine: "AquaVision", engineVersion: vision.analysis.engineVersion, modelVersion: vision.analysis.modelVersion }
        : { attemptedAt: now(), durationMs: vision.durationMs, outcome: "fallback", engine: "AquaVision", fallbackReason: vision.fallbackReason };
      const visionAttempts = [...(Array.isArray(job.visionAttempts) ? job.visionAttempts : []), visionAttempt];
      // Registra a tentativa antes do processamento local, inclusive se o fallback falhar.
      this.store.update("videoAnalysisJobs", job.id, {
        visionAttempts,
        ...(vision.kind === "success"
          ? { engine: vision.analysis.engine, engineVersion: vision.analysis.engineVersion, modelVersion: vision.analysis.modelVersion }
          : { fallbackReason: vision.fallbackReason }),
      });
      let analysis: Awaited<ReturnType<typeof analyzeVideo>> | VisionAnalysis;
      if (vision.kind === "success") {
        updateProgress(90, "Gerando quadro de referência");
        await generateThumbnail(videoPath, thumbnailPath, vision.analysis.metadata.durationSeconds);
        analysis = vision.analysis;
      } else {
        updateProgress(4, "Motor de visão indisponível — usando AquaMotion local");
        analysis = await analyzeVideo(videoPath, thumbnailPath, updateProgress);
      }
      const updated = this.store.update("videos", video.id, {
        status: "ready",
        analysisStatus: "ready",
        analysisProgress: 100,
        analysisStage: "Análise concluída",
        analysisJobId: job.id,
        analysis,
        thumbnailUrl: `/uploads/${thumbnail}`,
        ...analysis.metadata,
      }, "analyze");
      this.store.update("videoAnalysisJobs", job.id, {
        status: "completed", progress: 100, stage: "Análise concluída", completedAt: now(),
        visionAttempts,
        engine: analysis.engine, engineVersion: analysis.engineVersion, modelVersion: "modelVersion" in analysis ? analysis.modelVersion : undefined,
        fallbackReason: vision.kind === "fallback" ? vision.fallbackReason : undefined,
        result: { videoId: video.id, analyzedAt: analysis.analyzedAt, engine: analysis.engine },
      });
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha desconhecida na análise";
      this.store.update("videoAnalysisJobs", job.id, { status: "failed", stage: "Análise interrompida", error: message, completedAt: now() });
      this.store.update("videos", video.id, { analysisStatus: "failed", status: "ready", analysisStage: "Análise interrompida", analysisError: message, analysisJobId: job.id });
      return undefined;
    }
  }
}
