"use client";

/**
 * Painel do treinador de IA na revisão de vídeo: relatório completo do vídeo
 * (contexto total enviado ao modelo) e observações ao vivo sincronizadas com
 * a reprodução - uma janela por ~6 s, sem chamadas sobrepostas.
 */

import { useEffect, useRef, useState } from "react";
import { Radio, Sparkles } from "lucide-react";
import { apiRequest } from "./api";

type LiveNote = { t: number; text: string };

export const LIVE_WINDOW_SECONDS = 4;
const LIVE_INTERVAL_MS = 6000;
const LIVE_NOTES_LIMIT = 12;

export function VisionCoachPanel({ videoId, hasAnalysis, playing, currentTime, seek, engine }: {
  videoId: string;
  hasAnalysis: boolean;
  playing: boolean;
  currentTime: number;
  seek: (time: number) => void;
  engine?: string;
}) {
  const [report, setReport] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [liveVideoId, setLiveVideoId] = useState<string | null>(null);
  const live = liveVideoId === videoId;
  const [notes, setNotes] = useState<LiveNote[]>([]);
  const [error, setError] = useState("");
  const reportController = useRef<AbortController | null>(null);
  const timeRef = useRef(currentTime);
  timeRef.current = currentTime;

  useEffect(() => {
    setReport("");
    setReportBusy(false);
    setLiveVideoId(null);
    setNotes([]);
    setError("");
    return () => {
      reportController.current?.abort();
      reportController.current = null;
    };
  }, [videoId]);

  const requestReport = async () => {
    reportController.current?.abort();
    const controller = new AbortController();
    reportController.current = controller;
    setReportBusy(true);
    setError("");
    try {
      const response = await apiRequest<{ reply: string }>("/api/v1/ai/vision-coach/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setReport(response.reply);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Não foi possível gerar o relatório do treinador.");
    } finally {
      if (reportController.current === controller) {
        reportController.current = null;
        setReportBusy(false);
      }
    }
  };

  useEffect(() => {
    if (!live || !playing || !hasAnalysis) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    const tick = async () => {
      if (controller || cancelled) return;
      controller = new AbortController();
      const signal = controller.signal;
      const requestedTime = timeRef.current;
      try {
        const response = await apiRequest<{ reply: string }>("/api/v1/ai/vision-coach/live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId, currentTime: requestedTime, windowSeconds: LIVE_WINDOW_SECONDS }),
          signal,
        });
        if (!cancelled) setNotes((current) => [{ t: requestedTime, text: response.reply }, ...current].slice(0, LIVE_NOTES_LIMIT));
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "A análise ao vivo foi interrompida.");
        setLiveVideoId(null);
      } finally {
        controller = null;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), LIVE_INTERVAL_MS);
    return () => { cancelled = true; controller?.abort(); window.clearInterval(timer); };
  }, [live, playing, hasAnalysis, videoId]);

  return <div className="vision-coach">
    <div className="coach-toolbar">
      <button type="button" className="marker-ai-button" disabled={reportBusy || !hasAnalysis} onClick={() => void requestReport()}>
        <Sparkles size={14} />{reportBusy ? "Analisando o vídeo…" : "Relatório do treinador"}
      </button>
      <button type="button" className={`marker-ai-button ${live ? "active" : ""}`} disabled={!hasAnalysis} aria-pressed={live} onClick={() => { setError(""); setLiveVideoId(live ? null : videoId); }}>
        <Radio size={14} />{live ? (playing ? "Ao vivo · comentando" : "Ao vivo · reproduza para retomar") : "Análise ao vivo"}
      </button>
      {engine ? <em className="coach-engine">IA sobre {engine}</em> : null}
    </div>
    {error ? <div className="ai-summary ai-summary-error" role="alert">{error}</div> : null}
    {report ? <div className="ai-summary" role="status"><b>Relatório do treinador de seleção</b><p>{report}</p></div> : null}
    {live ? <div className="coach-live-feed" aria-live="polite">
      {notes.length
        ? notes.map((note) => <button type="button" className="coach-live-entry" key={`${note.t}-${note.text.slice(0, 12)}`} onClick={() => seek(note.t)}>
            <span>{note.t.toFixed(1)}s</span><p>{note.text}</p>
          </button>)
        : <p className="coach-live-empty">Dê play: a cada janela de {LIVE_WINDOW_SECONDS} s o treinador comenta o que os dados mostram agora.</p>}
    </div> : null}
  </div>;
}
