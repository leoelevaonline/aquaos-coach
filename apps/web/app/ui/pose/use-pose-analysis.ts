"use client";

import { useEffect, useRef, useState } from "react";
import {
  createPoseSession,
  hasNewVideoFrame,
  isVideoTimelineDiscontinuity,
  type ModelTier,
  type PoseSession,
  type TrackedAthlete,
} from "./engine";
import { drawPoseOverlay } from "./overlay";

export type PoseStatus = "idle" | "loading" | "running" | "error";

type PoseLoopParams = {
  enabled: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  numPoses: number;
  model: ModelTier;
  labelPrefix?: string;
};

/**
 * Loop de análise em tempo real: cria a sessão MediaPipe quando `enabled`,
 * processa cada quadro novo do vídeo, desenha o esqueleto no canvas e publica
 * as métricas no estado React em ~4 Hz para não storm de re-render.
 */
export function usePoseAnalysis({ enabled, videoRef, canvasRef, numPoses, model, labelPrefix = "Atleta" }: PoseLoopParams) {
  const [status, setStatus] = useState<PoseStatus>("idle");
  const [error, setError] = useState("");
  const [athletes, setAthletes] = useState<TrackedAthlete[]>([]);
  const [fps, setFps] = useState(0);
  const [inferenceMs, setInferenceMs] = useState(0);

  const sessionRef = useRef<PoseSession | null>(null);
  const rafRef = useRef(0);
  const lastVideoTimeRef = useRef<number | null>(null);
  const timelineVersionRef = useRef(0);
  const frameTimesRef = useRef<number[]>([]);
  const uiClockRef = useRef(0);
  const latestRef = useRef<TrackedAthlete[]>([]);
  const processFailuresRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let disposed = false;
    let observedVideo: HTMLVideoElement | null = null;
    setStatus("loading");
    setError("");

    const resetTimeline = () => {
      sessionRef.current?.reset();
      lastVideoTimeRef.current = null;
      timelineVersionRef.current += 1;
      latestRef.current = [];
      frameTimesRef.current = [];
      setAthletes([]);
      const canvas = canvasRef.current;
      if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    };

    const tick = () => {
      const session = sessionRef.current;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!session || !video || !canvas || disposed) return;
      if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
      }
      const videoTimeMs = Math.round(video.currentTime * 1000);
      if (video.readyState >= 2 && hasNewVideoFrame(lastVideoTimeRef.current, videoTimeMs)) {
        const previousVideoTimeMs = lastVideoTimeRef.current;
        lastVideoTimeRef.current = videoTimeMs;
        if (isVideoTimelineDiscontinuity(previousVideoTimeMs, videoTimeMs)) {
          resetTimeline();
          lastVideoTimeRef.current = videoTimeMs;
        }
        const timelineVersion = timelineVersionRef.current;
        void session.process(video, {
          mediaPipeTimeMs: performance.now(),
          videoTimeMs,
        }).then((output) => {
          if (!output || disposed || timelineVersion !== timelineVersionRef.current) return;
          processFailuresRef.current = 0;
          latestRef.current = output.athletes;
          frameTimesRef.current = [...frameTimesRef.current.slice(-60), performance.now()];
          drawPoseOverlay(canvas, {
            athletes: output.athletes.map((athlete) => ({
              landmarks: athlete.landmarks,
              label: `${labelPrefix} ${athlete.id + 1} · ${Math.round(athlete.metrics.cadence)}/min`,
            })),
          });
          const now = performance.now();
          if (now - uiClockRef.current > 250) {
            uiClockRef.current = now;
            setAthletes(output.athletes);
            setInferenceMs(output.inferenceMs);
            setFps(frameTimesRef.current.filter((time) => now - time <= 1000).length);
          }
        }).catch((cause) => {
          // Falhas de inferência não podem passar em silêncio: após algumas
          // tentativas consecutivas a UI precisa saber que o motor falhou.
          if (disposed) return;
          processFailuresRef.current += 1;
          if (processFailuresRef.current >= 3) {
            setStatus("error");
            setError(cause instanceof Error ? cause.message : "Falha na inferência de pose.");
          }
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        const session = await createPoseSession({ numPoses, model });
        if (cancelled) { void session.close(); return; }
        sessionRef.current = session;
        lastVideoTimeRef.current = null;
        timelineVersionRef.current = 0;
        observedVideo = videoRef.current;
        observedVideo?.addEventListener("seeking", resetTimeline);
        setStatus("running");
        rafRef.current = requestAnimationFrame(tick);
      } catch (cause) {
        if (cancelled) return;
        setStatus("error");
        setError(cause instanceof Error ? cause.message : "Não foi possível carregar o motor de análise.");
      }
    })();

    return () => {
      cancelled = true;
      disposed = true;
      observedVideo?.removeEventListener("seeking", resetTimeline);
      cancelAnimationFrame(rafRef.current);
      const session = sessionRef.current;
      sessionRef.current = null;
      lastVideoTimeRef.current = null;
      timelineVersionRef.current += 1;
      latestRef.current = [];
      frameTimesRef.current = [];
      setAthletes([]);
      if (session) void session.close();
      setStatus("idle");
    };
  }, [enabled, numPoses, model, videoRef, canvasRef, labelPrefix]);

  return { status, error, athletes, fps, inferenceMs };
}

export type { TrackedAthlete };
