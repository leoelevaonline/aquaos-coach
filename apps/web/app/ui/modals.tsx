"use client";

import { useEffect, useRef, useState } from "react";
import {
  Calendar, Camera, Check, CircleCheck, Download, Dumbbell, FileText, Film, Link2, MoreHorizontal, Pause,
  Play, Plus, RefreshCw, Send, ShieldCheck, SlidersHorizontal, Smartphone, Sparkles, Target,
  Trophy, Upload, UserPlus, UserRound, Users, Watch, Waves,
} from "lucide-react";
import { athletes, meets, videos, zoneDistribution } from "./demo-data";
import { Avatar, ModalShell } from "./components";
import { apiRequest, mediaUrl, subscribeToLiveEvents, uploadFile } from "./api";
import type { WorkoutSeed } from "./workout-library-actions";
import { LiveAnalysis, PoseTrackingLayer } from "./pose/LiveAnalysis";
import { trackColor, type TrackedKeyframe } from "./pose/server-track";
import { VisionCoachPanel } from "./vision-coach";

type SyncProvider = "garmin" | "polar" | "apple";

const syncProviders: Array<{ id: SyncProvider; name: string; detail: string; push: boolean }> = [
  { id: "garmin", name: "Garmin Connect", detail: "Importa atividades e envia treinos estruturados", push: true },
  { id: "polar", name: "Polar Flow", detail: "Importa sessões, sono e métricas de recuperação", push: false },
  { id: "apple", name: "Apple Health", detail: "Simulador. A operação real exige aplicativo iOS", push: true },
];

const syncAthletes = [
  { id: "ana-souza", name: "Ana Souza" },
  { id: "caio-martins", name: "Caio Martins" },
  { id: "luiza-costa", name: "Luiza Costa" },
  { id: "pedro-lima", name: "Pedro Lima" },
];

export function ConnectionDialog({ initialProvider = "garmin", onClose, onSave }: { initialProvider?: SyncProvider; onClose: () => void; onSave: (message: string) => void }) {
  const [provider, setProvider] = useState<SyncProvider>(initialProvider);
  const [athleteId, setAthleteId] = useState("ana-souza");
  const [direction, setDirection] = useState<"push" | "pull">("pull");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState("");
  const selected = syncProviders.find((item) => item.id === provider)!;
  const changeProvider = (next: SyncProvider) => {
    setProvider(next);
    setDirection(next === "polar" ? "pull" : direction);
    setResult("");
  };
  const synchronize = async () => {
    setRunning(true); setResult("");
    try {
      const response = await apiRequest<{ message: string }>(`/api/v1/sync/${provider}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ athleteId, direction }) });
      setResult(response.message);
      onSave(response.message);
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Não foi possível concluir a sincronização.");
    } finally { setRunning(false); }
  };
  return <ModalShell title="Conectar dispositivo" subtitle="Autorização, capacidades e teste do conector" onClose={onClose} wide>
    <div className="connection-dialog">
      <div className="connection-provider-list" role="radiogroup" aria-label="Provedor">
        {syncProviders.map((item) => <button key={item.id} role="radio" aria-checked={provider === item.id} className={provider === item.id ? "active" : ""} onClick={() => changeProvider(item.id)}><span>{item.id === "apple" ? <Smartphone size={20} /> : <Watch size={20} />}</span><div><b>{item.name}</b><small>{item.detail}</small></div>{provider === item.id && <CircleCheck size={18} />}</button>)}
      </div>
      <div className="connection-config">
        <span className="eyebrow accent">TESTE OPERACIONAL</span>
        <h3>{selected.name}</h3>
        <p>O piloto usa um conector simulado e registra o job, a origem e o resultado. Nenhuma credencial real é solicitada.</p>
        <div className="form-grid">
          <label className="wide"><span>Atleta</span><select value={athleteId} onChange={(event) => setAthleteId(event.target.value)}>{syncAthletes.map((athlete) => <option key={athlete.id} value={athlete.id}>{athlete.name}</option>)}</select></label>
          <label><span>Operação</span><select value={direction} onChange={(event) => setDirection(event.target.value as "push" | "pull")}><option value="pull">Importar atividade</option>{selected.push && <option value="push">Enviar treino</option>}</select></label>
          <label><span>Ambiente</span><input readOnly value="Simulador homologação" /></label>
        </div>
        <div className="capability-ledger"><span className="yes"><Download size={15} />Leitura disponível</span><span className={selected.push ? "yes" : "no"}><Send size={15} />{selected.push ? "Envio disponível" : "Envio não suportado"}</span><span className="yes"><ShieldCheck size={15} />Auditoria ativa</span></div>
        {result && <div className={`sync-result ${result.toLowerCase().includes("não") || result.toLowerCase().includes("falha") ? "error" : "success"}`}><CircleCheck size={18} /><span>{result}</span></div>}
      </div>
    </div>
    <footer className="modal-footer"><button className="secondary-button" onClick={onClose}>Fechar</button><button className="primary-button" disabled={running} onClick={() => void synchronize()}>{running ? <RefreshCw className="spin" size={16} /> : <Link2 size={16} />}{running ? "Sincronizando" : direction === "pull" ? "Importar agora" : "Enviar treino"}</button></footer>
  </ModalShell>;
}

export function WorkoutComposer({ seed, onClose, onSave }: { seed?: WorkoutSeed; onClose: () => void; onSave: (record: Record<string, unknown>) => void }) {
  const [title, setTitle] = useState(seed?.title ?? "Ritmo de 200 com fechamento forte");
  const [prompt, setPrompt] = useState(seed?.prompt ?? "Aquecimento 800 misto. 12x50 técnica a cada 1:00. Principal: 3 blocos de 4x100 no ritmo de 200, saída 1:35, com 200 A1 entre blocos. 600 soltura.");
  const [distanceMeters, setDistanceMeters] = useState(seed?.distanceMeters ?? 5200);
  const [zone, setZone] = useState(seed?.zone ?? "AN2");
  const [kind, setKind] = useState<"swim" | "strength">(seed?.kind ?? "swim");
  const [step, setStep] = useState(1);
  const [attachment, setAttachment] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [target, setTarget] = useState(seed?.target ?? "Equipe inteira");
  const [dateTime, setDateTime] = useState(seed?.scheduledAt ?? (() => { const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return `${date.toISOString().slice(0, 10)}T08:00`; })());
  const [pool, setPool] = useState("Olímpica · 50 m");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const photoInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const attach = async (file?: File) => { if (!file) return; try { await uploadFile(file, "documents", { title: `Anexo de treino · ${file.name}` }); setAttachment(file.name); } catch { setAttachment("Falha ao anexar - tente novamente"); } };
  const dictate = () => {
    type RecognitionEvent = { results: ArrayLike<{ 0: { transcript: string } }> };
    type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start: () => void; stop: () => void; onresult: ((event: RecognitionEvent) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
    const RecognitionCtor = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
    if (!RecognitionCtor) { setAttachment("Ditado não disponível neste navegador. Use o campo de texto."); return; }
    const recognition = new RecognitionCtor();
    recognition.lang = "pt-BR"; recognition.interimResults = false; recognition.continuous = false;
    recognition.onresult = (event) => setPrompt((value) => `${value} ${event.results[0][0].transcript}`.trim());
    recognition.onend = () => setDictating(false); recognition.onerror = () => { setDictating(false); setAttachment("Não foi possível captar o áudio."); };
    setDictating(true); recognition.start();
  };
  const publish = async () => {
    setPublishing(true); setError("");
    try {
      const assignment = target === "Equipe inteira" ? { targetType: "team", targetId: "org-demo" } : target === "Ana Souza" ? { targetType: "athlete", targetId: "ana-souza" } : { targetType: "group", targetId: target.startsWith("Elite") ? "elite" : target.startsWith("Desenvolvimento") ? "desenvolvimento" : target.toLowerCase().replace(/[^a-z0-9]+/g, "-") };
      const record = await apiRequest<Record<string, unknown>>(seed?.persistedId ? `/api/v1/manage/workouts/${seed.persistedId}` : "/api/v1/manage/workouts", { method: seed?.persistedId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: title.trim(), date: dateTime.slice(0, 10), scheduledAt: dateTime, distanceMeters, zone: kind === "strength" ? "FORÇA" : zone, kind, target, targetType: assignment.targetType, targetId: assignment.targetId, pool, note, status: "published", source: seed?.source ?? "coach-publish", publishedAt: new Date().toISOString(), prescriptionText: prompt, attachment: attachment || undefined }) });
      onSave(record);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível publicar o treino."); }
    finally { setPublishing(false); }
  };
  const validContent = title.trim().length >= 3 && prompt.trim().length >= 10 && (kind === "strength" || distanceMeters > 0);
  const scheduleLabel = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(dateTime));
  return <ModalShell title={seed?.persistedId ? "Editar evento da agenda" : "Criar treino na agenda"} subtitle="Conteúdo, estrutura e atribuição" onClose={onClose} wide><div className="composer-steps"><span className={step >= 1 ? "active" : ""}><i>1</i>Conteúdo</span><em /><span className={step >= 2 ? "active" : ""}><i>2</i>Estrutura</span><em /><span className={step >= 3 ? "active" : ""}><i>3</i>Publicar</span></div>{step === 1 && <div className="composer-body"><div className="schedule-context"><Calendar size={17} /><span><b>Evento agendado</b><small>{scheduleLabel}</small></span></div><label className="composer-title"><span>Título do treino</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label><div className="composer-metadata form-grid"><label><span>Modalidade</span><select value={kind} onChange={(event) => setKind(event.target.value as "swim" | "strength")}><option value="swim">Natação</option><option value="strength">Força</option></select></label><label><span>Volume total (m)</span><input type="number" min="0" step="50" disabled={kind === "strength"} value={kind === "strength" ? 0 : distanceMeters} onChange={(event) => setDistanceMeters(Math.max(0, Number(event.target.value) || 0))} /></label><label><span>Zona principal</span><select disabled={kind === "strength"} value={kind === "strength" ? "FORÇA" : zone} onChange={(event) => setZone(event.target.value)}>{["A1", "A2", "A3", "AN1", "AN2", "RP"].map((item) => <option key={item}>{item}</option>)}{kind === "strength" && <option>FORÇA</option>}</select></label></div><div className="composer-input"><span className="eyebrow accent">DESCREVA DO SEU JEITO</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /><div><button onClick={dictate} aria-pressed={dictating}><span className={dictating ? "recording" : ""}>●</span>{dictating ? "Ouvindo" : "Ditar"}</button><input ref={photoInput} hidden type="file" accept="image/*" onChange={(event) => void attach(event.target.files?.[0])} /><button onClick={() => photoInput.current?.click()}><Camera size={16} />Foto</button><input ref={documentInput} hidden type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.json,image/*" onChange={(event) => void attach(event.target.files?.[0])} /><button onClick={() => documentInput.current?.click()}><FileText size={16} />Documento</button><button className="assistant-chip" onClick={() => setPrompt((value) => `${value} Organize em blocos, valide a metragem total e proponha intervalos coerentes com as zonas.`)}><Sparkles size={16} />Peça ao RKF Coach</button></div>{attachment && <span className="attached-file"><CircleCheck size={13} />{attachment}</span>}</div><div className="assistant-suggestions"><span>SUGESTÕES</span><button onClick={() => setPrompt(`${prompt} Reduza 10% da metragem para atletas com readiness abaixo de 65.`)}>Reduzir 10% para baixa prontidão</button><button onClick={() => setPrompt(`${prompt} Troque o último bloco por técnica de virada.`)}>Adicionar técnica de virada</button><button onClick={() => setPrompt(`${prompt} Criar variação individual para fundistas.`)}>Variação para fundistas</button></div></div>}
    {step === 2 && <div className="structured-preview"><div className="workout-summary"><div><span className="option-icon aqua"><Waves size={19} /></span><div><b>{title}</b><small>{kind === "strength" ? "Sessão de força" : `${distanceMeters.toLocaleString("pt-BR")} m`} · {scheduleLabel}</small></div></div><span className={`zone-tag ${(kind === "strength" ? "força" : zone).toLowerCase()}`}>{kind === "strength" ? "FORÇA" : zone}</span></div>{prompt.split("\n").filter((line) => line.trim()).map((line, index) => <div className="workout-block" key={`${line}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{index === 0 ? "Bloco inicial" : `Bloco ${index + 1}`}</b><p>{line}</p></div><button className="icon-button" aria-label={`Editar bloco ${index + 1}`} onClick={() => setStep(1)}><MoreHorizontal size={17} /></button></div>)}</div>}
    {step === 3 && <div className="assignment-panel"><div><span className="eyebrow accent">ATRIBUIR PARA</span><div className="target-options">{[{ value: "Equipe inteira", icon: Users, label: "Equipe inteira", detail: "6 atletas" }, { value: "Ana Souza", icon: UserRound, label: "Um atleta", detail: "Individual" }, { value: "Elite · Raia 4", icon: Target, label: "Grupo", detail: "Raia ou nível" }].map(({ value, icon: Icon, label, detail }) => <label key={value}><input type="radio" name="target" checked={target === value} onChange={() => setTarget(value)} /><span><Icon size={18} /><b>{label}</b><small>{detail}</small></span></label>)}</div></div><div className="form-grid"><label><span>Data e hora</span><input type="datetime-local" value={dateTime} onChange={(event) => setDateTime(event.target.value)} /></label><label><span>Piscina</span><select value={pool} onChange={(event) => setPool(event.target.value)}><option>Olímpica · 50 m</option><option>Semiolímpica · 25 m</option></select></label><label className="wide"><span>Nota ao atleta</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Ex.: levar nadadeiras e palmar" /></label></div><div className="override-callout"><SlidersHorizontal size={19} /><div><b>Personalização sem duplicação</b><p>Após publicar, você poderá alterar volume, ritmo ou equipamento por atleta mantendo a sessão-base preservada.</p></div></div></div>}
    {error && <p className="composer-error" role="alert">{error}</p>}
    <footer className="modal-footer"><button className="secondary-button" onClick={step === 1 ? onClose : () => setStep(step - 1)}>{step === 1 ? "Cancelar" : "Voltar"}</button><button className="primary-button" disabled={publishing || (step === 1 && !validContent)} onClick={step === 3 ? () => void publish() : () => setStep(step + 1)}>{step === 1 ? <><Sparkles size={16} />Estruturar treino</> : step === 2 ? "Continuar" : <><Send size={16} />{publishing ? "Salvando…" : seed?.persistedId ? `Salvar em ${scheduleLabel}` : `Publicar em ${scheduleLabel}`}</>}</button></footer></ModalShell>;
}

export function InviteModal({ onClose, onSave }: { onClose: () => void; onSave: (invitationUrl?: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [group, setGroup] = useState("Elite · Raia 4");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [invitationUrl, setInvitationUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const save = async () => {
    if (!name || !email) return;
    setSaving(true); setError("");
    try {
      const result = await apiRequest<{ invitation?: { url?: string } }>("/api/v1/manage/athletes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, group, status: "invited", invitedAt: new Date().toISOString() }) });
      setInvitationUrl(result.invitation?.url ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível criar o convite.");
    } finally { setSaving(false); }
  };
  const copyInvitation = async () => { try { await navigator.clipboard.writeText(invitationUrl); setCopied(true); } catch { setCopied(false); } };
  return <ModalShell title="Convidar atleta" subtitle="Crie acesso individual e defina o grupo inicial" onClose={onClose}>{invitationUrl ? <><div className="invite-success"><CircleCheck size={30} /><h3>Convite criado</h3><p>Envie este link ao atleta. Ele expira em 7 dias e só pode ser utilizado uma vez.</p><div className="copy-field"><input readOnly value={invitationUrl} aria-label="Link do convite" /><button onClick={() => void copyInvitation()}>{copied ? "Copiado" : "Copiar"}</button></div></div><footer className="modal-footer"><button className="primary-button" onClick={() => { onSave(invitationUrl); onClose(); }}>Concluir</button></footer></> : <><div className="modal-form"><label><span>Nome completo</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nome do atleta" /></label><label><span>E-mail</span><input value={email} onChange={(event) => setEmail(event.target.value)} type="email" placeholder="atleta@email.com" /></label><label><span>Grupo</span><select value={group} onChange={(event) => setGroup(event.target.value)}><option>Elite · Raia 4</option><option>Desenvolvimento · Raia 3</option><option>Base · Raia 2</option><option>Águas abertas</option></select></label><div className="secure-note"><ShieldCheck size={18} /><p>O convite expira em 7 dias e pode ser revogado. O consentimento de dados de saúde é solicitado separadamente.</p></div>{error && <p className="modal-error" role="alert">{error}</p>}</div><footer className="modal-footer"><button className="secondary-button" onClick={onClose}>Cancelar</button><button className="primary-button" disabled={saving || !name || !email} onClick={() => void save()}><Send size={16} />{saving ? "Criando…" : "Criar convite"}</button></footer></>}</ModalShell>;
}

type MetricValidity = "measured" | "unavailable" | "uncalibrated" | "not_validated";
type SportMetric = { id: string; label: string; status: MetricValidity; unit: string; interval: { startSeconds: number; endSeconds: number }; coverage: number; source: string; sourceVersion: string; unavailableReason?: string; value?: number };
type VisionPerson = {
  id: number;
  idAliases?: number[];
  firstSeen: number;
  lastSeen: number;
  durationSeconds: number;
  gaps?: Array<{ from: number; to: number }>;
  strokes: number;
  strokeRate: number;
  rhythmConsistency: number;
  avgSpeed: number;
  maxSpeed: number;
  distance: number;
  distancePerStroke: number;
  units?: string;
  validity?: Partial<Record<"strokes" | "strokeRate" | "rhythmConsistency" | "avgSpeed" | "maxSpeed" | "distance" | "distancePerStroke", MetricValidity>>;
  meanConfidence: number;
  coverage: number;
  strokeSignal?: string | null;
  strokeTimes?: number[];
};
type MotionAnalysis = {
  engine: string;
  engineVersion: string;
  methodology: string;
  metadata: { durationSeconds: number; width: number; height: number; fps: number; sizeBytes: number; bitrate: number; units?: string; calibrated?: boolean; persons?: number; primaryPersonId?: number; keyframesTruncatedAt?: number | null; capabilities?: { athletes?: boolean; strokes?: boolean; speed?: boolean; pose?: boolean } };
  metrics: { detectedCycles?: number; estimatedCadence?: number; rhythmConsistency?: number; meanMotion: number; peakMotion: number };
  sportMetrics?: { contractVersion: string; metrics: SportMetric[] };
  timeline: { time: number; motion: number }[];
  events: { id: string; time: number; category: string; label: string; confidence: number; note?: string; personId?: number }[];
  people?: VisionPerson[];
  keyframes?: TrackedKeyframe[];
};
type ManagedVideo = { id: string; title?: string; athlete?: string; event?: string; url?: string; thumbnailUrl?: string; durationSeconds?: number; analysisStatus?: string; analysisProgress?: number; analysisStage?: string; analysisError?: string; analysisJobId?: string; analysis?: MotionAnalysis; manualEvents?: MotionAnalysis["events"] };
const clock = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}.${Math.floor((seconds % 1) * 10)}`;

/**
 * Valor de métrica com estado explícito: "—" quando não foi medido, sufixo
 * "px" quando não há calibração. Nunca mostra zero como se fosse medição.
 */
export function metricDisplay(person: VisionPerson, key: keyof NonNullable<VisionPerson["validity"]>, value: number, unit = ""): { value: string; note: string | null } {
  const state = person.validity?.[key] ?? (value > 0 ? "measured" : "unavailable");
  if (state === "unavailable") return { value: "—", note: "não medido" };
  if (state === "not_validated") return { value: "—", note: "não validado" };
  const units = person.units ?? "px";
  const rendered = `${value}${unit.replace("{u}", units)}`;
  return { value: rendered, note: state === "uncalibrated" ? "sem calibração" : null };
}

function sportMetricDisplay(analysis: MotionAnalysis | undefined, id: string, fallback: { value: string; note: string | null }) {
  const metric = analysis?.sportMetrics?.metrics.find((item) => item.id === id);
  if (!metric || metric.status === "measured") return fallback;
  return { value: "—", note: metric.status === "not_validated" ? "não validado" : metric.unavailableReason ?? "não medido" };
}

/** Rótulo curto do evento na linha do tempo, com o atleta quando houver. */
export function eventGlyph(event: MotionAnalysis["events"][number]): string {
  if (event.category === "stroke") return "B";
  if (event.category === "motion-peak") return "M";
  return event.label[0] ?? "•";
}

export function VideoReview({ videoId, onClose, onSave }: { videoId: string; onClose: () => void; onSave: () => void }) {
  const fallback = videos.find((item) => item.id === videoId) ?? videos[0];
  const player = useRef<HTMLVideoElement>(null);
  const [record, setRecord] = useState<ManagedVideo>({ id: fallback.id, title: fallback.event, athlete: fallback.athlete, event: fallback.event, url: "url" in fallback ? fallback.url : undefined, thumbnailUrl: "thumbnailUrl" in fallback ? fallback.thumbnailUrl : undefined });
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(Number("duration" in fallback ? fallback.duration.split(":").reduce((total, part) => total * 60 + Number(part), 0) : 0));
  const [playing, setPlaying] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [saveError, setSaveError] = useState("");
  const [processing, setProcessing] = useState(true);
  const [poseEnabled, setPoseEnabled] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<number | null>(null);
  const markers = ["Entrada", "Velocidade", "Virada", "Ritmo", "Chegada"];
  const applyRemote = (remote: ManagedVideo) => {
    setRecord(remote);
    const nextDuration = remote.analysis?.metadata.durationSeconds ?? remote.durationSeconds;
    if (nextDuration && Number.isFinite(nextDuration)) setDuration(nextDuration);
    setProcessing(["pending", "queued", "processing"].includes(String(remote.analysisStatus)));
  };
  const refresh = async () => {
    const remote = await apiRequest<ManagedVideo>(`/api/v1/manage/videos/${videoId}`);
    applyRemote(remote);
    return remote;
  };
  const load = async () => {
    try {
      const remote = await refresh();
      if (remote.analysisStatus !== "ready" && remote.analysisStatus !== "processing" && remote.analysisStatus !== "queued") {
        applyRemote(await apiRequest<ManagedVideo>(`/api/v1/videos/${videoId}/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
      }
    } catch { /* vídeos antigos permanecem disponíveis como demonstração */ }
  };
  useEffect(() => { void load(); }, [videoId]);
  useEffect(() => subscribeToLiveEvents((event) => {
    const belongsToVideo = (event.resource === "videos" && event.resourceId === videoId)
      || (event.resource === "videoAnalysisJobs" && event.record?.videoId === videoId);
    if (!belongsToVideo) return;
    if (event.resource === "videos" && event.record) applyRemote(event.record as ManagedVideo);
    else void refresh().catch(() => undefined);
  }), [videoId]);
  const analysis = record.analysis;
  const people = analysis?.people ?? [];
  const personIds = people.map((person) => person.id);
  const tracksAthletes = analysis ? analysis.metadata.capabilities?.athletes !== false && people.length > 0 : false;
  const focus = people.find((person) => person.id === selectedPerson) ?? people.find((person) => person.id === analysis?.metadata.primaryPersonId) ?? people[0];
  const sample = analysis?.timeline.reduce((best, item) => Math.abs(item.time - currentTime) < Math.abs(best.time - currentTime) ? item : best, analysis.timeline[0] ?? { time: 0, motion: 0 });
  const automaticEvents = (analysis?.events ?? []).filter((event) => selectedPerson === null || event.personId === undefined || event.personId === selectedPerson);
  const allEvents = [...automaticEvents, ...(record.manualEvents ?? [])].sort((a, b) => a.time - b.time);
  const activeEvent = [...allEvents].reverse().find((event) => event.time <= currentTime && currentTime - event.time < .6);
  const focusStrokes = focus?.strokeTimes ?? [];
  const strokesSoFar = focusStrokes.filter((time) => time <= currentTime).length;
  const inGap = focus?.gaps?.find((gap) => currentTime >= gap.from && currentTime <= gap.to) ?? null;
  const focusVisible = focus ? currentTime >= focus.firstSeen - .25 && currentTime <= focus.lastSeen + .25 && !inGap : false;
  const coverageEndsAt = analysis?.metadata.keyframesTruncatedAt ?? null;
  const phaseLabel = activeEvent?.label ?? (inGap && focus ? `Atleta #${focus.id} sem rastreio (${clock(inGap.from)}–${clock(inGap.to)})` : analysis && !tracksAthletes ? "Sem identificação de atletas" : "");
  const toggle = async () => { if (!player.current) return; if (player.current.paused) await player.current.play(); else player.current.pause(); };
  const seek = (time: number) => { if (player.current) player.current.currentTime = time; setCurrentTime(time); };
  const addMarker = async (label: string, index: number) => {
    const body = { time: currentTime, category: label.toLowerCase(), label: `${label} · validação do treinador`, ...(focus ? { personId: focus.id } : {}) };
    try { const updated = await apiRequest<ManagedVideo>(`/api/v1/videos/${videoId}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); setRecord(updated); } catch { setRecord((value) => ({ ...value, manualEvents: [...(value.manualEvents ?? []), { id: `local-${Date.now()}`, ...body, confidence: 100 }] })); }
  };
  const save = async () => {
    setSaveError("");
    try {
      await apiRequest(`/api/v1/manage/videos/${videoId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "reviewed", feedback, reviewedAt: new Date().toISOString() }) });
      onSave();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Não foi possível salvar a revisão.");
    }
  };
  const cadence = focus ? sportMetricDisplay(analysis, "cadence", metricDisplay(focus, "strokeRate", focus.strokeRate, "/min")) : null;
  const consistency = focus ? metricDisplay(focus, "rhythmConsistency", focus.rhythmConsistency, "%") : null;
  const speed = focus ? sportMetricDisplay(analysis, "speed", metricDisplay(focus, "avgSpeed", focus.avgSpeed, " {u}/s")) : null;
  const perStroke = focus ? sportMetricDisplay(analysis, "distance_per_cycle", metricDisplay(focus, "distancePerStroke", focus.distancePerStroke, " {u}")) : null;
  const cycles = analysis?.sportMetrics?.metrics.find((item) => item.id === "cycles");
  const engineNote = analysis
    ? tracksAthletes
      ? `${people.length} ${people.length === 1 ? "atleta rastreado" : "atletas rastreados"}${analysis.metadata.calibrated ? " · calibrado em metros" : " · sem calibração: distâncias em pixels"}${coverageEndsAt !== null ? ` · pose sincronizada até ${coverageEndsAt.toFixed(0)} s` : ""}`
      : "Este motor mede apenas o movimento global da cena: não identifica atletas, braçadas nem velocidade."
    : "";
  return <ModalShell title={`${record.athlete ?? fallback.athlete} · ${record.event ?? record.title ?? fallback.event}`} subtitle={`Análise sincronizada · ${analysis?.engine ?? "AquaMotion"} ${analysis?.engineVersion ?? ""}`} onClose={onClose} wide>
     <div className="live-analysis-banner"><span className={processing ? "processing" : record.analysisStatus === "failed" ? "failed" : "live"}><i />{processing ? `PROCESSANDO VÍDEO · ${record.analysisProgress ?? 0}%` : record.analysisStatus === "failed" ? "ANÁLISE INTERROMPIDA" : "ANÁLISE ATIVA"}</span><p>{processing ? record.analysisStage ?? "Aguardando processamento" : engineNote || record.analysisError || "Carregando metadados e curva de movimento…"}</p><em>{analysis ? `${analysis.metadata.width}×${analysis.metadata.height} · ${analysis.metadata.fps} fps` : ""}</em></div>
    <div className="review-layout real-review"><div><div className="review-player"><div className="real-video-stage"><video ref={player} src={mediaUrl(record.url)} poster={mediaUrl(record.thumbnailUrl)} playsInline preload="metadata" onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} /><button type="button" className={`pose-toggle ${poseEnabled ? "active" : ""}`} onClick={() => setPoseEnabled((value) => !value)} aria-pressed={poseEnabled} title={analysis?.keyframes?.length ? "Rastreamento AquaVision do servidor, sincronizado com a reprodução" : "Rastreamento de pose em tempo real no navegador"}><Sparkles size={15} />IA{analysis?.keyframes?.length ? " · servidor" : ""}</button>{poseEnabled && <PoseTrackingLayer videoRef={player} active serverKeyframes={analysis?.keyframes} serverPersonIds={personIds} selectedPersonId={selectedPerson} coverageEndsAt={coverageEndsAt} />}<button className="video-play-control" onClick={() => void toggle()}>{playing ? <Pause size={23} fill="currentColor" /> : <Play size={23} fill="currentColor" />}</button><span className="player-time">{clock(currentTime)} / {clock(duration)}</span>{phaseLabel ? <span className="active-phase">{phaseLabel}</span> : null}</div><div className="timeline live-timeline" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); seek(((event.clientX - rect.left) / rect.width) * duration); }}><i style={{ width: `${duration ? currentTime / duration * 100 : 0}%` }} />{focus?.gaps?.map((gap) => <s key={`${gap.from}-${gap.to}`} className="timeline-gap" title={`Sem rastreio ${clock(gap.from)}–${clock(gap.to)}`} style={{ left: `${duration ? gap.from / duration * 100 : 0}%`, width: `${duration ? (gap.to - gap.from) / duration * 100 : 0}%` }} />)}{allEvents.map((event) => <em key={event.id} title={`${event.label} · ${clock(event.time)}`} style={{ left: `${duration ? event.time / duration * 100 : 0}%`, background: typeof event.personId === "number" ? trackColor(event.personId, personIds) : zoneDistribution[4].color }} />)}</div></div>
      {tracksAthletes && people.length > 1 ? <div className="athlete-selector" role="tablist" aria-label="Atleta em foco"><button type="button" role="tab" aria-selected={selectedPerson === null} className={selectedPerson === null ? "active" : ""} onClick={() => setSelectedPerson(null)}>Todos</button>{people.map((person) => <button type="button" role="tab" key={person.id} aria-selected={selectedPerson === person.id} className={selectedPerson === person.id ? "active" : ""} onClick={() => setSelectedPerson(person.id)}><span className="tracked-athlete-dot" style={{ background: trackColor(person.id, personIds) }} />Atleta #{person.id}</button>)}</div> : null}
      {tracksAthletes && focus ? <div className="live-metrics" data-person={focus.id}><div><span>ATLETA #{focus.id}{selectedPerson === null && people.length > 1 ? " · PRINCIPAL" : ""}</span><b>{focusVisible ? "no quadro" : inGap ? "sem rastreio" : "fora do quadro"}</b><em>{Math.round(focus.meanConfidence * 100)}% conf · {focus.coverage}% cobertura</em></div><div><span>BRAÇADAS</span><b>{cycles ? "—" : strokesSoFar}{cycles ? null : <small> / {focus.strokes}</small>}</b><em>{cycles?.status === "not_validated" ? "não validado" : "até este quadro"}</em></div><div><span>CADÊNCIA</span><b>{cadence?.value}</b><em>{cadence?.note ?? `consistência ${consistency?.value}`}</em></div><div><span>VELOCIDADE MÉDIA</span><b>{speed?.value}</b><em>{speed?.note ?? (perStroke && perStroke.note === null ? `${perStroke.value} por ciclo` : "distância por ciclo não medida")}</em></div></div>
      : analysis ? <div className="live-metrics"><div><span>MOVIMENTO AGORA</span><b>{sample?.motion ?? 0}<small>/100</small></b><i style={{ width: `${sample?.motion ?? 0}%` }} /></div><div><span>PICOS DE MOVIMENTO</span><b>{allEvents.filter((event) => event.category === "motion-peak" && event.time <= currentTime).length}<small> / {analysis.metrics.detectedCycles}</small></b><em>movimento global da cena</em></div><div><span>ATLETAS</span><b>—</b><em>não identificados por este motor</em></div><div><span>CADÊNCIA</span><b>—</b><em>não medida</em></div></div> : null}
      <div className="marker-buttons">{markers.map((marker, index) => <button key={marker} onClick={() => void addMarker(marker, index)}><span style={{ background: zoneDistribution[index].color }}>{marker[0]}</span>{marker}<Plus size={14} /></button>)}</div>
      <VisionCoachPanel videoId={videoId} hasAnalysis={Boolean(analysis)} playing={playing} currentTime={currentTime} seek={seek} engine={analysis?.engine} />
      <label className="review-note"><span>Feedback para o atleta</span><textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Registre a evidência técnica e a próxima ação…" /></label></div>
      <aside className="review-sidebar">
        {tracksAthletes ? <div className="tracked-athletes"><span className="eyebrow">ATLETAS RASTREADOS · {people.length}</span>{people.slice(0, 6).map((person) => {
          const rate = sportMetricDisplay(analysis, "cadence", metricDisplay(person, "strokeRate", person.strokeRate, "/min"));
          const avg = sportMetricDisplay(analysis, "speed", metricDisplay(person, "avgSpeed", person.avgSpeed, " {u}/s"));
          return <button type="button" className={`tracked-athlete-row ${selectedPerson === person.id ? "active" : ""}`} key={person.id} onClick={() => setSelectedPerson(selectedPerson === person.id ? null : person.id)}><span className="tracked-athlete-dot" style={{ background: trackColor(person.id, personIds) }} /><div><b>Atleta #{person.id}</b><small>{clock(person.firstSeen)}–{clock(person.lastSeen)} · {cycles ? "ciclos não validados" : `${person.strokes} braçadas`} · {rate.value} · {avg.value}{avg.note ? ` (${avg.note})` : ""}</small></div><em>{person.gaps?.length ? `${person.gaps.length} lacuna${person.gaps.length > 1 ? "s" : ""}` : "contínuo"}</em></button>;
        })}</div> : null}
        <span className="eyebrow">LINHA DO TEMPO · {allEvents.length} EVENTOS</span>{allEvents.slice(0, 14).map((event) => <button className={`analysis-event ${Math.abs(event.time - currentTime) < .5 ? "active" : ""}`} key={event.id} onClick={() => seek(event.time)}><span style={{ background: typeof event.personId === "number" ? trackColor(event.personId, personIds) : zoneDistribution[4].color }}>{eventGlyph(event)}</span><div><b>{event.label}</b><small>{clock(event.time)} · {event.confidence}% confiança</small><p>{event.category === "stroke" ? "Pico periódico do keypoint de braçada." : event.category === "motion-peak" ? "Pico de movimento global da cena (não é braçada)." : "Marcação do treinador."}</p></div></button>)}</aside></div>
     {saveError && <p className="modal-error review-save-error" role="alert">{saveError}</p>}<footer className="modal-footer"><div className="analysis-summary"><Sparkles size={15} /><span>{analysis ? tracksAthletes && focus ? <><b>Atleta #{focus.id}: {focus.strokes} braçadas</b> · cadência {cadence?.value} · consistência {consistency?.value} · motor {analysis.engine}</> : <><b>{analysis.metrics.detectedCycles} picos de movimento</b> · sem identificação de atletas · motor {analysis.engine}</> : "Sem análise"}</span></div><button className="secondary-button" onClick={onClose}>Fechar</button><button className="primary-button" onClick={() => void save()}><Check size={16} />Salvar revisão</button></footer>
  </ModalShell>;
}

export function LiveAnalysisModal({ onClose }: { onClose: () => void }) {  return <ModalShell title="Análise ao vivo" subtitle="Pose, identificação de atletas e métricas biomecânicas em tempo real" onClose={onClose} wide className="live-analysis-modal">
    <LiveAnalysis />
  </ModalShell>;
}

/**
 * Índices de referência para piscina de 50 m, na faixa de um seletivo nacional.
 * Valores fixos: a tabela anterior derivava os tempos por aritmética e chegava a
 * marcas impossíveis ("0:77.50"), porque os segundos nunca viravam minuto.
 */
const MEET_STANDARDS = [
  { event: "50 Livre", fem: "0:26.30", masc: "0:23.40", athletes: 2 },
  { event: "100 Livre", fem: "0:57.20", masc: "0:51.60", athletes: 3 },
  { event: "200 Livre", fem: "2:03.80", masc: "1:52.40", athletes: 2 },
  { event: "100 Costas", fem: "1:04.90", masc: "0:57.80", athletes: 1 },
  { event: "100 Peito", fem: "1:12.40", masc: "1:03.20", athletes: 2 },
  { event: "100 Borboleta", fem: "1:03.10", masc: "0:55.90", athletes: 2 },
];

export function MeetDetail({ meetId, onClose, onNotify }: { meetId: string; onClose: () => void; onNotify: (message: string) => void }) {
  const fallbackMeet = meets.find((item) => item.id === meetId) ?? meets[0];
  const [meetRecord, setMeetRecord] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    setMeetRecord(null);
    void apiRequest<Record<string, unknown>>(`/api/v1/manage/meets/${meetId}`).then(setMeetRecord).catch(() => undefined);
  }, [meetId]);
  const startsOn = typeof meetRecord?.startsOn === "string" ? meetRecord.startsOn : "";
  const meet = meetRecord ? { ...fallbackMeet, id: String(meetRecord.id ?? meetId), name: String(meetRecord.name ?? fallbackMeet.name), priority: String(meetRecord.priority ?? fallbackMeet.priority) as "A" | "B" | "C", date: startsOn ? new Date(`${startsOn}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "").toUpperCase() : fallbackMeet.date, days: startsOn ? Math.max(0, Math.round((new Date(`${startsOn}T12:00:00`).getTime() - Date.now()) / 86_400_000)) : fallbackMeet.days, location: String(meetRecord.location ?? fallbackMeet.location), pool: String(meetRecord.pool ?? fallbackMeet.pool), qualified: Number(meetRecord.qualified ?? fallbackMeet.qualified), entries: Number(meetRecord.entries ?? fallbackMeet.entries) } : fallbackMeet;
  const [tab, setTab] = useState("Equipe");
  const docsInput = useRef<HTMLInputElement>(null);
  const attachDocument = async (file?: File) => { if (!file) return; try { await uploadFile(file, "documents", { title: `${meet.name} · ${file.name}`, referenceType: "meet", referenceId: meet.id }); onNotify("Documento anexado à competição."); } catch (error) { onNotify(error instanceof Error ? error.message : "Falha no documento"); } };
  const saveMeet = async () => { try { await apiRequest(`/api/v1/manage/meets/${meet.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: meet.name, priority: meet.priority, startsOn: startsOn || undefined, location: meet.location, pool: meet.pool, status: "planned", entries: meet.entries, qualified: meet.qualified }) }); onNotify("Alterações da competição salvas e auditadas."); } catch (error) { onNotify(error instanceof Error ? error.message : "Falha ao salvar competição"); } };
  return <ModalShell title={meet.name} subtitle={`${meet.date} · ${meet.location} · ${meet.pool}`} onClose={onClose} wide><div className="meet-modal-head"><span className={`meet-priority p${meet.priority.toLowerCase()}`}>{meet.priority}</span><div><b>Em {meet.days} dias</b><small>{meet.qualified} atletas com índice · {meet.entries} inscrições</small></div><button className="secondary-button" onClick={() => onNotify("Modo deck preparado para uso offline.")}><Smartphone size={16} />Abrir modo deck</button></div><div className="tab-bar modal-tabs">{["Equipe", "Programação", "Índices", "Provas"].map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div><div className="meet-tab-content">{tab === "Equipe" && <div className="meet-athletes">{athletes.slice(0, 4).map((athlete, index) => <div key={athlete.id}><Avatar initials={athlete.initials} color={athlete.color} small /><span><b>{athlete.name}</b><small>{athlete.goalEvent ?? "A definir"}</small></span><span className="qualified"><CircleCheck size={14} />{index < 3 ? "Com índice" : "Convidado"}</span><strong>{index + 2} provas</strong></div>)}</div>}{tab === "Programação" && <div className="meet-schedule">{[{ t: "07:00", n: "Chegada da equipe", k: "Operação" }, { t: "07:20", n: "Aquecimento na água", k: "Treino" }, { t: "08:45", n: "Abertura oficial", k: "Evento" }, { t: "09:00", n: "Início das eliminatórias", k: "Provas" }, { t: "17:00", n: "Sessão de finais", k: "Provas" }].map((item) => <div key={item.t}><strong>{item.t}</strong><i /><span><b>{item.n}</b><small>{item.k}</small></span></div>)}</div>}{tab === "Índices" && <div className="standards-table"><div><span>PROVA</span><span>FEM · 50 M</span><span>MASC · 50 M</span><span>ATLETAS</span></div>{MEET_STANDARDS.map((standard) => <div key={standard.event}><b>{standard.event}</b><span>{standard.fem}</span><span>{standard.masc}</span><strong>{standard.athletes}</strong></div>)}</div>}{tab === "Provas" && <div className="entries-grid">{athletes.slice(0, 4).map((athlete) => <article key={athlete.id}><div><Avatar initials={athlete.initials} color={athlete.color} small /><b>{athlete.name}</b></div><span>{athlete.goalEvent ?? "100 m Livre"}</span><small>Balizamento pendente</small></article>)}</div>}</div><footer className="modal-footer"><input ref={docsInput} hidden type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,image/*" onChange={(event) => void attachDocument(event.target.files?.[0])} /><button className="secondary-button" onClick={() => docsInput.current?.click()}><Upload size={16} />Documentos</button><button className="primary-button" onClick={() => void saveMeet()}>Salvar competição</button></footer></ModalShell>;
}

export function QuickCreate({ onClose, onSelect }: { onClose: () => void; onSelect: (choice: string) => void }) {
  const options = [{ n: "Treino", d: "Natação ou força", i: Waves }, { n: "Atleta", d: "Novo prontuário", i: UserPlus }, { n: "Competição", d: "Calendário e provas", i: Trophy }, { n: "Vídeo", d: "Upload e revisão", i: Film }, { n: "Objetivo", d: "Meta individual", i: Target }, { n: "Convite", d: "Equipe ou comissão", i: Send }];
  return <ModalShell title="Criar" subtitle="Comece qualquer fluxo sem perder o contexto" onClose={onClose}><div className="quick-grid">{options.map((option) => <button key={option.n} onClick={() => onSelect(option.n)}><span><option.i size={20} /></span><div><b>{option.n}</b><small>{option.d}</small></div><strong>›</strong></button>)}</div></ModalShell>;
}
