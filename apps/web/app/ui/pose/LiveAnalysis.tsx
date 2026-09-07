"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, Camera, Cpu, Gauge, Radio, Sparkles, Upload, Users, X } from "lucide-react";
import { usePoseAnalysis, type PoseStatus } from "./use-pose-analysis";
import { drawPoseOverlay } from "./overlay";
import { ServerTrackingLayer, type TrackedKeyframe } from "./server-track";
import type { ModelTier } from "./engine";

const MODEL_OPTIONS: Array<{ id: ModelTier; label: string; hint: string }> = [
  { id: "lite", label: "Rápida", hint: "Maior FPS em máquinas modestas" },
  { id: "full", label: "Equilibrada", hint: "Precisão e fluidez (recomendado)" },
  { id: "heavy", label: "Máxima", hint: "Maior precisão, exige GPU forte" },
];

const PRIMARY_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26];

function metricEntries(): Array<{ label: string; value: string }> {
  return [
    { label: "Braçadas/min", value: "—" },
    { label: "Simetria", value: "—" },
    { label: "Ritmo", value: "—" },
    { label: "Amplitude", value: "—" },
    { label: "Tronco", value: "—" },
    { label: "Estabilidade", value: "—" },
  ];
}

function SourceButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof Camera; label: string; onClick: () => void }) {
  return <button type="button" className={`live-source-button ${active ? "active" : ""}`} onClick={onClick} aria-pressed={active}><Icon size={15} />{label}</button>;
}

function StatusPill({ status, error }: { status: PoseStatus; error: string }) {
  if (status === "error") return <span className="live-pill error"><X size={13} />{error || "Motor indisponível"}</span>;
  if (status === "loading") return <span className="live-pill loading"><span className="live-spinner" />Carregando modelo de pose…</span>;
  if (status === "running") return <span className="live-pill running"><i />RASTREAMENTO ATIVO</span>;
  return <span className="live-pill idle">Motor em espera</span>;
}

/** Painel completo: câmera ao vivo ou arquivo de vídeo com métricas por atleta. */
export function LiveAnalysis({ initialSourceUrl }: { initialSourceUrl?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<"camera" | "file">(initialSourceUrl ? "file" : "camera");
  const [sourceUrl, setSourceUrl] = useState(initialSourceUrl ?? "");
  const [numPoses, setNumPoses] = useState(1);
  const [model, setModel] = useState<ModelTier>("full");
  const [streaming, setStreaming] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const analysis = usePoseAnalysis({ enabled: streaming, videoRef, canvasRef, numPoses, model });

  const stopMedia = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) { video.pause(); video.srcObject = null; }
    setStreaming(false);
  };

  useEffect(() => stopMedia, []);

  const start = async () => {
    setSourceError("");
    const video = videoRef.current;
    if (!video) return;
    try {
      if (source === "camera") {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
        streamRef.current = stream;
        video.srcObject = stream;
      } else if (!sourceUrl) {
        fileInput.current?.click();
        return;
      } else {
        video.srcObject = null;
        video.src = sourceUrl;
      }
      video.muted = true;
      await video.play();
      setStreaming(true);
    } catch (cause) {
      setStreaming(false);
      setSourceError(cause instanceof Error ? cause.message : "Falha ao iniciar a fonte de vídeo.");
    }
  };

  const pickFile = (file?: File) => {
    if (!file) return;
    stopMedia();
    setSourceUrl(URL.createObjectURL(file));
    setSource("file");
  };

  const changeSource = (next: "camera" | "file") => {
    stopMedia();
    setSource(next);
    setSourceUrl(next === "camera" ? "" : sourceUrl);
  };

  return <div className="live-analysis">
    <div className="live-toolbar">
      <div className="live-source-group">
        <SourceButton active={source === "camera"} icon={Camera} label="Câmera ao vivo" onClick={() => changeSource("camera")} />
        <SourceButton active={source === "file"} icon={Upload} label="Arquivo de vídeo" onClick={() => changeSource("file")} />
        <input ref={fileInput} hidden type="file" accept="video/*" onChange={(event) => pickFile(event.target.files?.[0])} />
        {source === "file" && <button type="button" className="secondary-button" onClick={() => fileInput.current?.click()}>Escolher vídeo</button>}
      </div>
      <label className="live-control"><Users size={14} /><select value={numPoses} onChange={(event) => setNumPoses(Number(event.target.value))} aria-label="Número de atletas">
        {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count} {count === 1 ? "atleta" : "atletas"}</option>)}
      </select></label>
      <label className="live-control"><Sparkles size={14} /><select value={model} onChange={(event) => setModel(event.target.value as ModelTier)} aria-label="Precisão do modelo">
        {MODEL_OPTIONS.map((option) => <option key={option.id} value={option.id}>Precisão {option.label}</option>)}
      </select></label>
      {streaming
        ? <button type="button" className="secondary-button" onClick={stopMedia}><X size={15} />Parar análise</button>
        : <button type="button" className="primary-button" onClick={() => void start()}><Radio size={15} />Iniciar análise</button>}
    </div>
    <p className="live-hint">{MODEL_OPTIONS.find((option) => option.id === model)?.hint} · tudo roda no navegador, o vídeo não sai do dispositivo.</p>

    <div className="live-stage">
      <video ref={videoRef} playsInline muted />
      <canvas ref={canvasRef} />
      {!streaming && <div className="live-stage-placeholder"><Radio size={26} /><b>Escolha a fonte e inicie a análise</b><small>A câmera pede permissão do navegador; o arquivo roda direto do seu disco.</small></div>}
      <div className="live-stage-status"><StatusPill status={analysis.status} error={[sourceError, analysis.error].filter(Boolean).join(" · ")} />{analysis.status === "running" && <><span className="live-chip"><Gauge size={13} />{analysis.fps} fps</span><span className="live-chip"><Cpu size={13} />{analysis.inferenceMs} ms</span><span className="live-chip"><Activity size={13} />{analysis.athletes.length} {analysis.athletes.length === 1 ? "atleta" : "atletas"}</span></>}</div>
    </div>

    {analysis.athletes.length > 0 && <div className="live-athletes">
      {analysis.athletes.map((athlete) => <article className="live-athlete-card" key={athlete.id}>
        <header><span className="live-athlete-dot" style={{ background: "#22d3ee" }} /><b>Atleta {athlete.id + 1}</b><small>confiança {athlete.metrics.confidence}%</small></header>
        <div className="live-metric-grid">{metricEntries().map((entry) => <div key={entry.label}><span>{entry.label}</span><strong>{entry.value}</strong></div>)}</div>
        <small>Métricas esportivas não validadas para esta câmera.</small>
        <div className="live-confidence-bar"><i style={{ width: `${athlete.metrics.confidence}%` }} /></div>
      </article>)}
    </div>}
    {analysis.status === "running" && !analysis.athletes.length && <p className="live-empty">Nenhum atleta no quadro ainda — aproxime-se da câmera ou avance o vídeo.</p>}
  </div>;
}

/** Camada compacta usada dentro do modal de revisão: esqueleto sobre o vídeo do acervo. */
export function PoseTrackingLayer({ videoRef, active, numPoses = 1, serverKeyframes, serverPersonIds = [], selectedPersonId = null, coverageEndsAt = null }: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  active: boolean;
  numPoses?: number;
  serverKeyframes?: TrackedKeyframe[];
  serverPersonIds?: number[];
  selectedPersonId?: number | null;
  coverageEndsAt?: number | null;
}) {
  // Fonte prioritária: keyframes do AquaVision (servidor) quando a análise os
  // traz; sem eles, rastreamento MediaPipe no próprio navegador.
  if (serverKeyframes?.length) return <ServerTrackingLayer videoRef={videoRef} active={active} keyframes={serverKeyframes} personIds={serverPersonIds} selectedId={selectedPersonId} coverageEndsAt={coverageEndsAt} />;
  return <BrowserTrackingLayer videoRef={videoRef} active={active} numPoses={numPoses} />;
}

function BrowserTrackingLayer({ videoRef, active, numPoses = 1 }: { videoRef: React.RefObject<HTMLVideoElement | null>; active: boolean; numPoses?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analysis = usePoseAnalysis({ enabled: active, videoRef, canvasRef, numPoses, model: "full", labelPrefix: "Atleta" });
  const athlete = analysis.athletes[0];
  useEffect(() => {
    if (!active) {
      const canvas = canvasRef.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [active]);
  if (!active) return null;
  return <>
    <canvas ref={canvasRef} className="pose-tracking-canvas" />
    {analysis.status === "loading" && <span className="pose-tracking-chip pose-tracking-chip-loading"><span className="live-spinner" />Carregando rastreamento…</span>}
    {analysis.status === "error" && <span className="pose-tracking-chip pose-tracking-chip-error" role="alert">Rastreamento indisponível neste navegador: {analysis.error}</span>}
    {athlete && <span className="pose-tracking-chip"><Sparkles size={12} />Atleta {athlete.id + 1} · métricas esportivas não validadas · {athlete.metrics.confidence}% conf.</span>}
  </>;
}

// Reexport para testes e futuras integrações.
export { drawPoseOverlay };
