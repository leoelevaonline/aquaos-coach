"use client";

import { useEffect, useRef, useState } from "react";
import {
  Activity, ArrowRight, BarChart3, Calendar, Check, CircleCheck, Cloud, Database,
  Download, FileText, Film, Gauge, HeartPulse, Link2, Lock, MapPin, MoreHorizontal,
  Plus, Radio, RefreshCw, Search, Send, Settings, ShieldCheck, Sparkles, Target, Trophy,
  Upload, UserPlus, Users, Video, Watch, Waves,
} from "lucide-react";
import { athletes, connectors, hydrateAthlete, insights, meets, season, videos, zoneDistribution } from "./demo-data";
import { Avatar, Metric, PageTitle, SectionHead, StatusDot } from "./components";
import type { AppView } from "./views-primary";
import { apiRequest, mediaUrl, subscribeToLiveEvents, uploadFile } from "./api";
import { CycleOverview, ReadinessPanel } from "./coach-panels";
import { CoachEyeWorkspace } from "./coach-eye";
import { csvRow, downloadFile } from "./client-utils";

export function Season({ onMeet, onSettings, onCreateMeet, onNotify, liveVersion = 0 }: { onMeet: (id: string) => void; onSettings: () => void; onCreateMeet: () => void; onNotify: (message: string) => void; liveVersion?: number }) {
  const [liveMeets, setLiveMeets] = useState(meets);
  useEffect(() => {
    void apiRequest<{ data: Array<Record<string, unknown>> }>("/api/v1/manage/meets")
      .then((response) => setLiveMeets(response.data.map((record, index) => {
        const startsOn = String(record.startsOn ?? "");
        const date = startsOn ? new Date(`${startsOn}T12:00:00`) : new Date();
        return { id: String(record.id ?? `meet-${index}`), name: String(record.name ?? "Competição sem nome"), priority: String(record.priority ?? "B") as "A" | "B" | "C", date: startsOn ? date.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "").toUpperCase() : "A DEFINIR", days: startsOn ? Math.max(0, Math.round((date.getTime() - Date.now()) / 86_400_000)) : 0, location: String(record.location ?? "Local a definir"), pool: String(record.pool ?? "50 m"), qualified: Number(record.qualified ?? 0), entries: Number(record.entries ?? 0) };
      })))
      .catch(() => setLiveMeets(meets));
  }, [liveVersion]);
  return <>
    <PageTitle kicker="TEMPORADA" title="Temporada" subtitle="Macrociclo completo, competições e prontidão"><button className="secondary-button" onClick={onSettings}><Settings size={17} />Ajustes</button><button className="primary-button" onClick={onCreateMeet}><Plus size={17} />Nova competição</button></PageTitle>
    <CycleOverview /><ReadinessPanel />
     <section className="season-columns"><div className="card"><SectionHead title="Próximas competições" subtitle={`${liveMeets.length} eventos no calendário · prioridades, índices e inscrições`} action="Calendário completo" onAction={() => onNotify("Calendário anual exibido com fases e competições.")} /><div className="meet-list">{liveMeets.map((meet) => <button key={meet.id} onClick={() => onMeet(meet.id)}><span className={`meet-priority p${meet.priority.toLowerCase()}`}>{meet.priority}</span><div><b>{meet.name}</b><small><MapPin size={13} />{meet.location} · {meet.pool}</small></div><div><strong>{meet.date}</strong><small>{meet.days ? `em ${meet.days} dias` : "data a definir"}</small></div><div><b>{meet.qualified}</b><small>com índice</small></div><ArrowRight size={16} /></button>)}</div></div></section>
  </>;
}

type VideoListItem = { id: string; athlete: string; initials: string; color: string; event: string; time: string; date: string; status: string; duration: string; markers: number; progress?: number; real?: boolean; url?: string; thumbnailUrl?: string };

export function Videos({ onVideo, onLive, onNotify, liveVersion = 0 }: { onVideo: (id: string) => void; onLive: () => void; onNotify: (message: string) => void; liveVersion?: number }) {
  const [filter, setFilter] = useState("Todos");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<VideoListItem[]>(videos);
  const [uploadTitle, setUploadTitle] = useState("");
  const uploadInput = useRef<HTMLInputElement>(null);
  const loadVideos = async () => {
    try {
      const result = await apiRequest<{ data: Array<Record<string, unknown> & { id: string }> }>("/api/v1/manage/videos");
      const remote = result.data.map((record, index): VideoListItem => ({ id: record.id, athlete: String(record.athlete ?? athletes.find((athlete) => athlete.id === record.athleteId)?.name ?? "Atleta não definido"), initials: String(record.athlete ?? "AN").split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase(), color: ["#7357ef", "#0da98b", "#397ac4", "#e35f65"][index % 4], event: String(record.event ?? record.title ?? "Sessão técnica"), time: typeof record.durationSeconds === "number" ? `${Number(record.durationSeconds).toFixed(2).replace(".", ",")} s` : "Processando", date: typeof record.createdAt === "string" ? new Date(record.createdAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "") : "agora", status: record.analysisStatus === "ready" ? (record.status === "reviewed" ? "done" : "review") : ["pending", "queued", "processing"].includes(String(record.analysisStatus)) ? "processing" : String(record.status ?? "review"), duration: typeof record.durationSeconds === "number" ? `00:${String(Math.round(Number(record.durationSeconds))).padStart(2, "0")}` : "-", markers: Number((record.analysis as { events?: unknown[] } | undefined)?.events?.length ?? 0), progress: Number(record.analysisProgress ?? 0), real: true, url: String(record.url ?? ""), thumbnailUrl: String(record.thumbnailUrl ?? "") }));
      setCatalog(remote);
    } catch { /* mantém catálogo local se a API estiver indisponível */ }
  };
  useEffect(() => { void loadVideos(); }, [liveVersion]);
  useEffect(() => subscribeToLiveEvents((event) => {
    if (event.resource === "videos" || event.resource === "videoAnalysisJobs") void loadVideos();
  }), []);
  const shown = catalog.filter((video) => (filter === "Todos" || (filter === "Para revisar" && video.status === "review") || (filter === "Revisados" && video.status === "done")) && `${video.athlete} ${video.event}`.toLowerCase().includes(query.toLowerCase()));
  const handleUpload = async (file?: File) => {
    if (!file) return;
    try {
      const record = await uploadFile(file, "videos", { title: uploadTitle.trim() || file.name.replace(/\.[^.]+$/, "") });
      onNotify("Vídeo armazenado. A análise de movimento foi iniciada.");
      if (typeof record.id === "string") await apiRequest(`/api/v1/videos/${record.id}/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      setUploadTitle("");
      await loadVideos();
    } catch (error) { onNotify(error instanceof Error ? error.message : "Falha ao enviar vídeo"); }
  };
  return <><CoachEyeWorkspace /><PageTitle kicker="ANÁLISE TÉCNICA" title="Vídeos de prova e treino" subtitle="Movimento, ciclos e evidências técnicas sincronizados ao vídeo real."><button className="secondary-button" onClick={onLive}><Radio size={17} />Análise ao vivo</button><button className="secondary-button" onClick={() => onNotify("Modo deck aberto: câmera, cronômetro e registro de prova preparados.")}><Video size={17} />Gravar no deck</button><input ref={uploadInput} hidden type="file" accept=".mp4,.mov,.m4v,video/mp4,video/quicktime" onChange={(event) => void handleUpload(event.target.files?.[0])} /><button className="primary-button" onClick={() => uploadInput.current?.click()}><Upload size={17} />Enviar vídeo</button></PageTitle>
     <div className="video-upload-context"><div><span className="eyebrow accent">CONTEXTO DO ENVIO</span><strong>O envio não associa pessoa alguma aos tracks técnicos.</strong><small>A associação é sempre manual, feita na revisão e registrada no histórico.</small></div><label><span>Título opcional</span><input value={uploadTitle} onChange={(event) => setUploadTitle(event.target.value)} placeholder="Ex.: virada submersa · série 3" /></label></div>
     <div className="video-stats"><div><Film size={19} /><span><b>{catalog.length}</b> provas filmadas</span></div><div><Activity size={19} /><span><b>{catalog.filter((item) => item.status === "review" || item.status === "processing").length}</b> aguardando revisão</span></div><div><BarChart3 size={19} /><span><b>{catalog.filter((item) => item.date.toLowerCase().includes("ago") || item.date.toLowerCase() === "agora").length}</b> esta semana</span></div></div>
    <div className="roster-toolbar video-toolbar"><div className="filter-pills">{["Todos", "Para revisar", "Revisados"].map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div><div className="local-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Atleta ou prova" /></div></div>
     <section className="video-grid">{shown.map((video, index) => <article className="card video-card" key={video.id}><button className="video-thumb" onClick={() => onVideo(video.id)}><div className={`pool-frame frame-${index + 1}`}>{video.thumbnailUrl ? <img src={mediaUrl(video.thumbnailUrl)} alt={`Quadro de ${video.event}`} /> : <><span className="lane-line l1" /><span className="lane-line l2" /><span className="lane-line l3" /></>}<i>▶</i><em>{video.duration}</em><span className="real-video-chip">{video.status === "processing" ? `PROCESSANDO ${video.progress ?? 0}%` : video.real ? "ANÁLISE REAL" : "CATÁLOGO"}</span></div></button><div className="video-meta"><div><Avatar initials={video.initials} color={video.color} small /><span><b>{video.athlete}</b><small>{video.date}</small></span><span className={video.status === "review" ? "review-badge" : video.status === "processing" ? "processing-badge" : "done-badge"}>{video.status === "review" ? "Para revisar" : video.status === "processing" ? "Processando" : "Revisado"}</span></div><h3>{video.event} · {video.time}</h3>{video.status === "processing" && <div className="video-progress"><i style={{ width: `${video.progress ?? 0}%` }} /></div>}<div><span><Sparkles size={14} />{video.markers} eventos detectados</span><button onClick={() => onVideo(video.id)}>Abrir análise<ArrowRight size={15} /></button></div></div></article>)}</section></>;
}

type AnalyticsOverview = {
  metrics: { activeAthletes: number; readinessAverage: number | null; sleepAverage: number | null; attendanceAverage: number | null; healthCoverage: number; videoCoverage: number; videosTotal: number; videosPending: number; resultsCount: number; plannedMeters: number; completedMeters: number; adherence: number | null };
  weekly: Array<{ label: string; plannedMeters: number; completedMeters: number; load: number; zones: Record<string, number> }>;
};

export function Analytics({ onAthlete, onNotify, liveVersion = 0 }: { onAthlete: (id: string) => void; onNotify: (message: string) => void; liveVersion?: number }) {
  const [weeks, setWeeks] = useState(8);
  const [metric, setMetric] = useState<"volume" | "carga">("volume");
  const [descending, setDescending] = useState(true);
  const [classic, setClassic] = useState(false);
  const [roster, setRoster] = useState(athletes);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  useEffect(() => {
    void Promise.all([
      apiRequest<{ data: Array<Record<string, unknown>> }>("/api/v1/manage/athletes"),
      apiRequest<AnalyticsOverview>(`/api/v1/analytics/overview?weeks=${weeks}`),
    ]).then(([athleteResponse, analyticsResponse]) => {
      setRoster(athleteResponse.data.map(hydrateAthlete));
      setOverview(analyticsResponse);
    }).catch(() => setRoster(athletes));
  }, [liveVersion, weeks]);
  const activeRoster = roster.filter((athlete) => athlete.account === "active");
  const readiness = activeRoster.flatMap((athlete) => typeof athlete.readiness === "number" ? [athlete.readiness] : []);
  const attendance = activeRoster.length ? Math.round(activeRoster.reduce((sum, athlete) => sum + athlete.attendance, 0) / activeRoster.length) : 0;
  const metrics = overview?.metrics;
  const chartSeries = overview?.weekly.length ? overview.weekly : [74, 82, 76, 91, 88, 84, 96, 93].map((value, index) => ({ label: `S${index + 1}`, plannedMeters: value * 1000, completedMeters: value * 920, load: value * 10, zones: {} }));
  const chartMax = Math.max(...chartSeries.map((item) => metric === "volume" ? item.plannedMeters : item.load), 1);
  const goalAthletes = [...roster.filter((athlete) => athlete.goalEvent)].sort((a, b) => descending ? String(b.gap).localeCompare(String(a.gap)) : String(a.gap).localeCompare(String(b.gap)));
  const exportReport = () => {
    const rows = [csvRow(["Atleta", "Objetivo", "Gap", "Presença", "Readiness"]), ...roster.map((athlete) => csvRow([athlete.name, athlete.goalEvent ?? "Sem meta", athlete.gap ?? "-", `${athlete.attendance}%`, athlete.readiness ?? "Sem dado"]))];
    downloadFile(`analise-programa-${weeks}-semanas.csv`, rows.join("\n"));
    onNotify("Relatório executivo exportado em CSV.");
  };
  return <><PageTitle kicker="INTELIGÊNCIA DO PROGRAMA" title="Análise" subtitle="Do planejamento à prova: uma leitura executiva do elenco."><button className="secondary-button" onClick={() => setWeeks((value) => value === 4 ? 8 : value === 8 ? 12 : 4)}><Calendar size={17} />Últimas {weeks} semanas</button><button className="primary-button" onClick={exportReport}><Download size={17} />Exportar relatório</button></PageTitle>
     <div className="metric-grid"><Metric label="ADERÊNCIA À CARGA" value={metrics?.adherence == null ? "—" : `${metrics.adherence.toFixed(1).replace(".", ",")}%`} detail={metrics ? `${(metrics.completedMeters / 1000).toFixed(1).replace(".", ",")} km realizados na janela` : "Calculando"} icon={Target} /><Metric label="EVOLUÇÃO DE PBS" value={`+${metrics?.resultsCount ?? 0}`} detail="Resultados no prontuário" icon={Trophy} tone="violet" /><Metric label="SAÚDE DO ELENCO" value={metrics?.readinessAverage == null ? "—" : `${Math.round(metrics.readinessAverage)}%`} detail={metrics ? `${activeRoster.filter((athlete) => (athlete.readiness ?? 100) < 65).length} alertas de recuperação` : "Sem dados de corpo"} icon={HeartPulse} tone="blue" /><Metric label="COBERTURA DE DADOS" value={metrics ? `${metrics.healthCoverage}%` : "—"} detail={metrics ? `${metrics.videosTotal} vídeos · ${metrics.videosPending} pendentes` : "Calculando"} icon={Database} tone="orange" /></div>
     <section className={`analytics-grid ${classic ? "classic-view" : ""}`}><article className="card program-volume"><SectionHead title={metric === "volume" ? "Volume do time por zona" : "Carga interna por semana"} subtitle={`Prescrito × realizado · ${weeks} semanas`} action="Trocar métrica" onAction={() => setMetric((value) => value === "volume" ? "carga" : "volume")} /><div className="chart-y-labels"><span>{metric === "volume" ? "40 km" : "900 u.a."}</span><span>{metric === "volume" ? "30 km" : "675 u.a."}</span><span>{metric === "volume" ? "20 km" : "450 u.a."}</span><span>{metric === "volume" ? "10 km" : "225 u.a."}</span><span>0</span></div><div className="stacked-chart">{chartSeries.map((item, i) => { const total = metric === "volume" ? item.plannedMeters : item.load; const height = Math.max(8, total / chartMax * 100); return <div key={`${item.label}-${i}`} style={{ height: `${height}%` }}><span style={{ height: "28%", background: zoneDistribution[0].color }} /><span style={{ height: "34%", background: zoneDistribution[1].color }} /><span style={{ height: "19%", background: zoneDistribution[2].color }} /><span style={{ height: "11%", background: zoneDistribution[3].color }} /><span style={{ height: "8%", background: zoneDistribution[4].color }} /><small>{item.label}</small></div>; })}</div><div className="zone-legend">{zoneDistribution.map((zone) => <span key={zone.code}><i style={{ background: zone.color }} />{zone.code}</span>)}</div></article>
      <article className="card goal-map"><SectionHead title="Distância até a meta" subtitle="Cada atleta contra seu próprio objetivo" action={descending ? "Maior gap primeiro" : "Menor gap primeiro"} onAction={() => setDescending((value) => !value)} /><div className="goal-athletes">{goalAthletes.map((athlete, index) => <button key={athlete.id} onClick={() => onAthlete(athlete.id)}><Avatar initials={athlete.initials} color={athlete.color} small /><div><span><b>{athlete.name}</b><small>{athlete.goalEvent}</small></span><div><i style={{ width: `${Math.max(4, 82 - index * 8)}%` }} /><em style={{ left: `${Math.max(4, 82 - index * 8)}%` }} /></div></div><strong>{athlete.gap}</strong></button>)}</div></article>
       <article className="card roster-performance"><SectionHead title="Visão do elenco" subtitle={`${activeRoster.length} atletas ativos · presença média ${attendance}%`} action={classic ? "Visão executiva" : "Visão clássica"} onAction={() => setClassic((value) => !value)} /><div className="performance-head"><span>ATLETA</span><span>GAP</span><span>PRES.</span><span>HABILIDADES</span></div>{roster.map((athlete) => <button key={athlete.id} onClick={() => onAthlete(athlete.id)}><span><Avatar initials={athlete.initials} color={athlete.color} small /><span><b>{athlete.name}</b><small>{athlete.goalEvent ?? "Sem meta"}</small></span></span><strong>{athlete.gap ?? "-"}</strong><strong>{athlete.attendance ? `${athlete.attendance}%` : "—"}</strong><span className="skill-pills">{athlete.skills.length ? athlete.skills.map((skill) => <i key={skill.key} className={skill.score >= 80 ? "high" : skill.score >= 65 ? "mid" : "low"}>{skill.key}</i>) : <small>Sem evidências</small>}</span></button>)}</article>
       <article className="card recovery-map"><SectionHead title="Recuperação do elenco" subtitle="Readiness × carga aguda" /><div className="quadrant"><span className="axis-label y">READINESS</span><span className="axis-label x">CARGA AGUDA</span><div className="quad-label q1">Pronto para carga</div><div className="quad-label q2">Monitorar</div><div className="quad-label q3">Recuperar</div>{roster.filter((a) => a.readiness).map((athlete, i) => <button key={athlete.id} onClick={() => onAthlete(athlete.id)} style={{ left: `${Math.min(84, 28 + i * 10)}%`, bottom: `${22 + (athlete.readiness ?? 0) * .58}%`, background: athlete.color }} title={`Abrir ${athlete.name}`}>{athlete.initials}</button>)}</div></article>
    </section></>;
}

export function News({ onNavigate, onAthlete, onNotify }: { onNavigate: (view: AppView) => void; onAthlete: (id: string) => void; onNotify: (message: string) => void }) {
  const [filter, setFilter] = useState<"Prioridade" | "Todos" | "Resolvidos">("Prioridade");
  const [resolved, setResolved] = useState<string[]>([]);
  const visible = insights.filter((item) => filter === "Todos" || (filter === "Resolvidos" ? resolved.includes(item.id) : !resolved.includes(item.id) && ["critical", "warning", "video"].includes(item.type)));
  const markAllRead = () => { setResolved(insights.map((item) => item.id)); setFilter("Resolvidos"); onNotify("Todos os alertas foram marcados como resolvidos."); };
  return <><PageTitle kicker="CENTRAL DE DECISÕES" title="Novidades" subtitle="Alertas explicáveis, ordenados por impacto e sempre ligados a uma ação."><button className="secondary-button" onClick={() => onNavigate("settings")}><Settings size={17} />Preferências</button><button className="primary-button" onClick={markAllRead}><Check size={17} />Marcar como lidas</button></PageTitle>
    <section className="inbox-layout"><div className="card inbox-list"><div className="inbox-tabs">{(["Prioridade", "Todos", "Resolvidos"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}{item !== "Resolvidos" && <span>{item === "Prioridade" ? 3 : insights.length}</span>}</button>)}</div>{visible.map((item) => <article className="inbox-item" key={item.id}><span className={`insight-icon ${item.type}`}>{item.type === "critical" ? <HeartPulse size={19} /> : item.type === "video" ? <Film size={19} /> : item.type === "success" ? <Trophy size={19} /> : item.type === "account" ? <UserPlus size={19} /> : <Activity size={19} />}</span><div><div><b>{item.title}</b><small>{item.time}</small></div><p>{item.body}</p><button onClick={() => item.target === "videos" ? onNavigate("videos") : item.type === "account" ? onNotify("Convite reenviado para Gabriel.") : onAthlete(item.target)}>{item.action}<ArrowRight size={14} /></button></div><button className="icon-button" aria-label={`Resolver alerta: ${item.title}`} onClick={() => { setResolved((value) => [...new Set([...value, item.id])]); onNotify(`Alerta resolvido: ${item.title}`); }}><Check size={17} /></button></article>)}{!visible.length && <div className="empty-state"><CircleCheck size={28} /><strong>Nenhum alerta nesta visão</strong><p>As decisões resolvidas permanecem disponíveis para auditoria.</p></div>}</div><aside className="stack"><article className="card weekly-digest"><Sparkles size={22} /><span>RESUMO INTELIGENTE</span><h3>A semana em 60 segundos</h3><p>O volume subiu <b>6,8%</b> com boa aderência. Ana respondeu melhor ao bloco AN2. Luiza precisa de recuperação antes do próximo estímulo AN1.</p><button className="secondary-button" onClick={() => onNotify("Resumo completo aberto com carga, aderência, recuperação e próximos riscos.")}>Abrir resumo completo</button></article><article className="card rule-card"><SectionHead title="Motor de regras" subtitle="Automações ativas" action="Configurar" onAction={() => onNavigate("settings")} /><div><span><CircleCheck size={16} />Queda de volume</span><em>Ativo</em></div><div><span><CircleCheck size={16} />Readiness crítico</span><em>Ativo</em></div><div><span><CircleCheck size={16} />Sem vídeo recente</span><em>Ativo</em></div><div><span><CircleCheck size={16} />Meta se aproximando</span><em>Ativo</em></div></article></aside></section></>;
}

export function Integrations({ onNotify, onCreateConnection, liveVersion = 0 }: { onNotify: (message: string) => void; onCreateConnection: (provider?: "garmin" | "polar" | "apple") => void; liveVersion?: number }) {
  const [syncStats, setSyncStats] = useState({ connections: 0, events: 0, lastSync: "Sem sincronização" });
  const [providerCounts, setProviderCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    void Promise.all([
      apiRequest<{ data: Array<Record<string, unknown>> }>("/api/v1/manage/syncJobs"),
      apiRequest<{ data: Array<Record<string, unknown>> }>("/api/v1/manage/activities"),
    ]).then(([jobs, activities]) => {
      const counts: Record<string, number> = {};
      for (const job of jobs.data) { const provider = String(job.provider ?? ""); if (provider) counts[provider] = (counts[provider] ?? 0) + 1; }
      const latest = jobs.data.map((job) => String(job.completedAt ?? job.updatedAt ?? "")).filter(Boolean).sort().at(-1);
      setProviderCounts(counts);
      setSyncStats({ connections: new Set(jobs.data.map((job) => `${job.provider}:${job.athleteId}`)).size, events: activities.data.length, lastSync: latest ? new Date(latest).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "Sem sincronização" });
    }).catch(() => undefined);
  }, [liveVersion]);
  const visibleConnectors = connectors.map((connector) => ({ ...connector, athletes: providerCounts[connector.id] ?? connector.athletes, status: providerCounts[connector.id] ? "connected" : connector.status }));
  const exportLogs = () => { downloadFile("logs-sincronizacao.csv", [csvRow(["Horário", "Conector", "Estado", "Eventos"]), csvRow(["29/08/2026 02:47", "Garmin", "sucesso", 42]), csvRow(["29/08/2026 02:44", "Polar", "sucesso", 31]), csvRow(["29/08/2026 02:41", "Apple Health", "simulado", 55])].join("\n")); onNotify("Logs de sincronização exportados."); };
  return <><PageTitle kicker="ECOSSISTEMA DE DADOS" title="Integrações" subtitle="Conectores versionados, consentimento por atleta e rastreabilidade total."><button className="secondary-button" onClick={exportLogs}><FileText size={17} />Logs de sincronização</button><button className="primary-button" onClick={() => onCreateConnection()}><Plus size={17} />Nova conexão</button></PageTitle>
     <div className="integration-summary"><div><Cloud size={21} /><span><b>{syncStats.connections || "—"} atletas sincronizados</b><small>Última coleta {syncStats.lastSync}</small></span></div><div><RefreshCw size={21} /><span><b>{syncStats.events} eventos importados</b><small>Idempotência por origem ativa</small></span></div><div><ShieldCheck size={21} /><span><b>Consentimentos válidos</b><small>LGPD · auditoria ativa</small></span></div></div>
     <section className="connector-grid">{visibleConnectors.map((connector) => <article className="card connector-card" key={connector.id}><div className="connector-head"><span className={`connector-mark ${connector.id}`}>{connector.mark}</span><div><h3>{connector.name}</h3><p>{connector.category}</p></div><span className={`connector-status ${connector.status}`}>{connector.status === "connected" ? "Conectado" : connector.status === "native" ? "Requer app" : "Disponível"}</span></div><p className="connector-note">{connector.note}</p><div className="capabilities"><span className={connector.read ? "yes" : "no"}><Download size={14} />Consumir dados</span><span className={connector.write ? "yes" : "no"}><Send size={14} />Enviar treino</span></div><div className="connector-footer"><span><Users size={15} />{connector.athletes} atleta{connector.athletes === 1 ? "" : "s"}</span><button onClick={() => connector.id === "garmin" || connector.id === "polar" || connector.id === "apple" ? onCreateConnection(connector.id) : onNotify(`${connector.name}: conector de leitura preparado para a fase de homologação real.`)}>{connector.status === "connected" ? "Gerenciar" : connector.status === "native" ? "Ver requisitos" : "Conectar"}<ArrowRight size={14} /></button></div></article>)}</section>
    <article className="card sync-architecture"><div className="architecture-copy"><span className="eyebrow accent">ARQUITETURA PREPARADA</span><h2>Uma camada comum, conectores independentes.</h2><p>Cada origem declara suas capacidades. A plataforma preserva o payload bruto, normaliza a atividade e impede duplicidade antes de recalcular carga.</p></div><div className="flow-diagram"><div><Watch size={20} /><span>Dispositivo</span></div><ArrowRight size={18} /><div><Cloud size={20} /><span>Conector</span></div><ArrowRight size={18} /><div><Database size={20} /><span>Normalização</span></div><ArrowRight size={18} /><div><Gauge size={20} /><span>RKF Coach</span></div></div></article>
  </>;
}

export function ProgramSettings({ onNotify }: { onNotify: (message: string) => void }) {
  type ZoneDraft = { code: string; label: string; color: string; pace: string };
  const [tab, setTab] = useState("Programa");
  const logoInput = useRef<HTMLInputElement>(null);
  const [logoName, setLogoName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [programName, setProgramName] = useState("Seleção Nacional de Natação");
  const [programLocale, setProgramLocale] = useState("pt-BR");
  const [primaryPool, setPrimaryPool] = useState("50 m");
  const [identityName, setIdentityName] = useState("Seleção Nacional");
  const [identityColor, setIdentityColor] = useState("#0C8F7C");
  const [zoneDrafts, setZoneDrafts] = useState<ZoneDraft[]>(() => zoneDistribution.map((zone) => ({ code: zone.code, label: zone.label, color: zone.color, pace: zone.pace })));
  useEffect(() => {
    void apiRequest<{ data: Array<Record<string, unknown>> }>("/api/v1/manage/settings")
      .then((response) => {
        const program = response.data.find((record) => record.id === "program");
        if (!program) return;
        if (typeof program.organizationName === "string") setProgramName(program.organizationName);
        if (typeof program.locale === "string") setProgramLocale(program.locale);
        if (typeof program.primaryPool === "string") setPrimaryPool(program.primaryPool.replace(/.*?(\d+\s*m)$/i, "$1"));
        if (typeof program.identityName === "string") setIdentityName(program.identityName);
        if (typeof program.identityColor === "string") setIdentityColor(program.identityColor);
        if (typeof program.logoUrl === "string") setLogoUrl(program.logoUrl);
      }).catch(() => undefined);
  }, []);
  useEffect(() => {
    void apiRequest<{ data: Array<Record<string, unknown>> }>("/api/v1/manage/zones")
      .then((response) => {
        if (!response.data.length) return;
        setZoneDrafts(response.data.filter((record) => String(record.status ?? "active") !== "retired").sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)).map((record) => ({ code: String(record.code ?? record.id), label: String(record.name ?? "").replace(/^.*?·\s*/, "") || "Zona personalizada", color: String(record.color ?? "#2da7c7"), pace: String(record.pace ?? "Individual") })));
      }).catch(() => undefined);
  }, []);
  const copyInvite = async () => { try { await navigator.clipboard.writeText("https://aquaos.app/join/selecao-nacional"); onNotify("Link de convite copiado."); } catch { onNotify("Link selecionado para cópia manual."); } };
  const saveProgram = async () => { try { await apiRequest("/api/v1/manage/settings/program", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationName: programName.trim(), locale: programLocale, measurementSystem: "metric", primaryPool, updatedBy: "Leonardo Martins" }) }); onNotify("Configurações do programa salvas e auditadas."); } catch (error) { onNotify(error instanceof Error ? error.message : "Falha ao salvar configurações"); } };
  const uploadLogo = async (file: File) => { try { const record = await uploadFile(file, "documents", { title: `Logo · ${file.name}`, referenceType: "organization", referenceId: "org-demo" }); setLogoName(file.name); setLogoUrl(String(record.url ?? "")); onNotify("Logo armazenado com hash e pronto para publicar."); } catch (error) { onNotify(error instanceof Error ? error.message : "Falha ao armazenar logo"); } };
  const saveIdentity = async () => { try { await apiRequest("/api/v1/manage/settings/program", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identityName: identityName.trim(), identityColor, logoUrl }) }); onNotify("Identidade atualizada e registrada na auditoria."); } catch (error) { onNotify(error instanceof Error ? error.message : "Falha ao salvar identidade"); } };
  const updateZone = (index: number, key: keyof ZoneDraft, value: string) => setZoneDrafts((current) => current.map((zone, zoneIndex) => zoneIndex === index ? { ...zone, [key]: value } : zone));
  const addZone = () => setZoneDrafts((current) => [...current, { code: `Z${current.length + 1}`, label: "Nova zona", color: "#7b8bd8", pace: "Individual" }]);
  const saveZones = async () => { try { await Promise.all(zoneDrafts.map(async (zone, index) => { const body = { id: zone.code.toLowerCase(), name: `${zone.code} · ${zone.label}`, code: zone.code, color: zone.color, pace: zone.pace, status: "active", order: index + 1 }; try { return await apiRequest(`/api/v1/manage/zones/${zone.code.toLowerCase()}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); } catch { return apiRequest("/api/v1/manage/zones", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); } })); onNotify("Zonas atualizadas; histórico preservado."); } catch (error) { onNotify(error instanceof Error ? error.message : "Falha ao salvar zonas"); } };
  return <><PageTitle kicker="ADMINISTRAÇÃO" title="Configurações" subtitle="Identidade, método, comissão, zonas, privacidade e operação." />
    <section className="settings-layout"><aside className="settings-menu">{["Programa", "Comissão técnica", "Zonas de intensidade", "Identidade", "Notificações", "Privacidade e LGPD", "Conta"].map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</aside><div className="card settings-panel">
       {tab === "Programa" && <><SectionHead title="Programa de performance" subtitle="Configurações principais da organização" /><div className="form-grid"><label><span>Nome do programa</span><input value={programName} onChange={(event) => setProgramName(event.target.value)} /></label><label><span>Idioma padrão</span><select value={programLocale} onChange={(event) => setProgramLocale(event.target.value)}><option value="pt-BR">Português (Brasil)</option><option>English</option><option>Español</option><option>Français</option></select></label><label><span>Sistema de medidas</span><select defaultValue="metric"><option value="metric">Métrico · metros</option></select></label><label><span>Piscina principal</span><select value={primaryPool} onChange={(event) => setPrimaryPool(event.target.value)}><option value="50 m">Olímpica · 50 m</option><option value="25 m">Semiolímpica · 25 m</option></select></label></div><div className="settings-callout"><Sparkles size={20} /><div><b>Motor de carga ativo: RkfLoadEngine V5.1</b><p>Determinístico, versionado e em validação com o pacote canônico RKF. Resultados oficiais dependem da homologação do treinador.</p></div><button className="secondary-button" onClick={() => { downloadFile("contrato-motor-carga-rkf.json", JSON.stringify({ version: "RKF_V5.1", status: "validation", inputs: ["prescrição", "execução", "zonas", "feedback"], outputs: ["métricas", "componentes", "explicação"] }, null, 2), "application/json"); onNotify("Contrato versionado do motor RKF exportado."); }}>Ver contrato</button></div><button className="primary-button" onClick={() => void saveProgram()}>Salvar alterações</button></>}
      {tab === "Comissão técnica" && <><SectionHead title="Comissão técnica" subtitle="Papéis e acesso por organização" action="Convidar profissional" onAction={() => onNotify("Formulário de convite da comissão aberto com papel e nível de acesso.")} /><div className="staff-list">{[{ n: "Leonardo Martins", r: "Administrador · acesso total", i: "LM", c: "#0b927d" }, { n: "Camila Ferreira", r: "Treinadora · acesso total", i: "CF", c: "#7357ef" }, { n: "Rafael Nunes", r: "Fisiologista · somente leitura", i: "RN", c: "#397ac4" }].map((member) => <div key={member.n}><Avatar initials={member.i} color={member.c} /><span><b>{member.n}</b><small>{member.r}</small></span><span className="active-access"><StatusDot />Ativo</span><button className="icon-button" aria-label={`Gerenciar ${member.n}`} onClick={() => onNotify(`Permissões de ${member.n} abertas para edição.`)}><MoreHorizontal size={18} /></button></div>)}</div></>}
       {tab === "Zonas de intensidade" && <><SectionHead title="Zonas de intensidade" subtitle="Reordene, personalize ou aposente sem perder o histórico" action="Adicionar zona" onAction={addZone} /><div className="zone-settings">{zoneDrafts.map((zone, index) => <div key={`${zone.code}-${index}`}><span className="drag-handle">⋮⋮</span><i style={{ background: zone.color }} /><input value={zone.code} onChange={(event) => updateZone(index, "code", event.target.value.toUpperCase())} aria-label={`Código da zona ${index + 1}`} /><input value={zone.label} onChange={(event) => updateZone(index, "label", event.target.value)} aria-label={`Nome da zona ${index + 1}`} /><input value={zone.pace} onChange={(event) => updateZone(index, "pace", event.target.value)} aria-label={`Ritmo da zona ${index + 1}`} /><button className="icon-button" aria-label={`Gerenciar zona ${zone.code}`} onClick={() => onNotify(`Opções de ordenar, aposentar e duplicar a zona ${zone.code} abertas.`)}><MoreHorizontal size={17} /></button></div>)}</div><button className="primary-button" onClick={() => void saveZones()}>Salvar zonas</button></>}
       {tab === "Identidade" && <><SectionHead title="Identidade da equipe" subtitle="Visível nos convites e na área do atleta" /><div className="identity-editor"><div className="logo-upload">{logoUrl ? <img src={mediaUrl(logoUrl)} alt="Logo da equipe" /> : <Waves size={30} />}<input ref={logoInput} hidden type="file" accept="image/png,image/jpeg" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadLogo(file); }} /><button onClick={() => logoInput.current?.click()}>{logoName || logoUrl ? "Trocar logo" : "Alterar logo"}</button>{logoName && <small>{logoName}</small>}</div><div className="form-grid"><label><span>Nome exibido</span><input value={identityName} onChange={(event) => setIdentityName(event.target.value)} /></label><label><span>Cor principal</span><input value={identityColor} onChange={(event) => setIdentityColor(event.target.value)} /></label><label className="wide"><span>Link de convite</span><div className="copy-field"><input readOnly value="aquaos.app/join/selecao-nacional" /><button onClick={() => void copyInvite()}>Copiar</button></div></label></div></div><button className="primary-button" onClick={() => void saveIdentity()}>Salvar identidade</button></>}
      {tab === "Notificações" && <><SectionHead title="Notificações" subtitle="Tudo permanece no RKF Coach; escolha o que também chega por e-mail" /><div className="toggle-list">{["Feedback em vídeo", "Respostas ao feedback", "Alertas de readiness", "Falhas de sincronização", "Mensagens da equipe", "Resumo semanal"].map((item, index) => <label key={item}><span><b>{item}</b><small>{index < 2 ? "Atletas e comissão" : "Somente comissão"}</small></span><input type="checkbox" defaultChecked={index !== 4} /><i /></label>)}</div><button className="primary-button" onClick={() => onNotify("Preferências de notificação salvas.")}>Salvar preferências</button></>}
      {tab === "Privacidade e LGPD" && <><SectionHead title="Privacidade e LGPD" subtitle="Dados esportivos e de saúde com governança explícita" /><div className="privacy-grid"><div><ShieldCheck size={21} /><b>Consentimentos</b><p>5 válidos · 1 pendente</p><button onClick={() => onNotify("Registro de consentimentos aberto com vigência e origem.")}>Gerenciar</button></div><div><Download size={21} /><b>Exportações</b><p>Portabilidade por atleta</p><button onClick={() => onNotify("Solicitação de portabilidade criada e auditada.")}>Solicitar</button></div><div><Lock size={21} /><b>Credenciais</b><p>Criptografadas e segregadas</p><button onClick={() => onNotify("Auditoria de credenciais concluída sem exposição de segredos.")}>Auditar</button></div><div><Database size={21} /><b>Retenção</b><p>Política configurável</p><button onClick={() => onNotify("Política de retenção aberta para configuração.")}>Configurar</button></div></div></>}
      {tab === "Conta" && <><SectionHead title="Sua conta" subtitle="Perfil, acesso e preferências pessoais" /><div className="account-profile"><Avatar initials="LM" color="#0b927d" /><div><b>Leonardo Martins</b><small>leonardo@aquaos.app · Brasil</small></div><button className="secondary-button" onClick={() => onNotify("Editor de perfil aberto.")}>Editar perfil</button></div><div className="form-grid"><label><span>Idioma</span><select><option>Português (Brasil)</option></select></label><label><span>Fuso horário</span><select><option>America/Sao_Paulo</option></select></label></div><button className="primary-button" onClick={() => onNotify("Preferências da conta salvas.")}>Salvar conta</button></>}
    </div></section>
  </>;
}
