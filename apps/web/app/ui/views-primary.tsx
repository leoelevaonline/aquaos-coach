"use client";

import { useEffect, useRef, useState } from "react";
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3, Calendar, Camera,
  ChevronLeft, ChevronRight, CircleCheck, Clock, Download, Dumbbell, FileText,
  Film, Gauge, HeartPulse, Library, MapPin, MessageSquare, Mic, Moon, MoreHorizontal,
  Plus, Search, SlidersHorizontal, Smartphone, Sparkles, Target, Trophy, Upload, UserPlus,
  UserRound, Users, Watch, Waves,
} from "lucide-react";
import { athletes, hydrateAthlete, meets as demoMeets, practices, strengthLibrary, workoutLibrary, zoneDistribution, type AthleteProfile } from "./demo-data";
import { Avatar, formatNumber, Metric, PageTitle, ProgressRing, SectionHead, StatusDot } from "./components";
import { API_URL, apiRequest, importFile } from "./api";
import { csvRow, downloadFile } from "./client-utils";
import {
  AthleteMessageDialog, BodyReadinessDialog, EvidenceDialog, GoalEditor, MethodologyDialog, exportAthletePerformance,
  initialGoalFor, calculateGoalPacing, type AthletePanel,
} from "./athlete-performance-actions";
import { ReadinessPanel, DailyWater, CycleOverview } from "./coach-panels";
import { WorkoutTemplateEditor, type WorkoutSeed } from "./workout-library-actions";

export type AppView = "today" | "athletes" | "practices" | "seasons" | "videos" | "analytics" | "rkf" | "inbox" | "integrations" | "settings" | "race" | "protocols" | "ai";

type AutomationProposal = { id: string; athleteId: string; athleteName: string; priority: "CRITICAL" | "HIGH" | "MEDIUM" | "OPPORTUNITY"; action: string; title: string; rationale: string; triggers: string[]; requiresCoachApproval: boolean; updatedAt: string };
type AutomationSnapshot = { engineVersion: string; latestRun?: { updatedAt?: string; cause?: string }; counts: { critical: number; high: number; medium: number; opportunity: number; requiringApproval: number }; proposals: AutomationProposal[] };
type TodayAnalytics = { metrics: { plannedMeters: number; completedMeters: number; adherence: number | null }; weekly: Array<{ label: string; plannedMeters: number; completedMeters: number }> };

export function Today({ onCreate, onNavigate, onAthlete, onNotify, liveVersion = 0 }: { onCreate: () => void; onNavigate: (view: AppView) => void; onAthlete: (id: string) => void; onNotify: (message: string) => void; liveVersion?: number }) {
  // Data e saudação ao vivo (cliente, evita mismatch de hidratação)
  const [today, setToday] = useState<{ kicker: string; greeting: string } | null>(null);
  // Atletas reais da API; contagem sempre consistente com a lista exibida
  const [roster, setRoster] = useState<AthleteProfile[] | null>(null);
  // Próxima competição do calendário (fallback: demo em dev)
  const [meet, setMeet] = useState<{ name: string; startsOn?: string; pool?: string; priority?: string; qualified?: number; entries?: number } | null>(null);
  const [videoSummary, setVideoSummary] = useState({ total: 0, pending: 0 });
  const [automation, setAutomation] = useState<AutomationSnapshot | null>(null);
  const [analytics, setAnalytics] = useState<TodayAnalytics | null>(null);
  const [automationBusy, setAutomationBusy] = useState<string | null>(null);

  useEffect(() => {
    const now = new Date();
    const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "long" }).format(now).toUpperCase();
    const dateLabel = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long" }).format(now).toUpperCase();
    const hour = now.getHours();
    setToday({ kicker: `${weekday} · ${dateLabel}`, greeting: hour < 12 ? "Bom dia, Leonardo." : hour < 18 ? "Boa tarde, Leonardo." : "Boa noite, Leonardo." });
    void apiRequest<{ data: Array<Record<string, unknown>> }>("/api/v1/athletes")
      .then((response) => {
        const live = (response.data ?? []).map(hydrateAthlete);
        if (live.length) setRoster(live);
        else if (process.env.NODE_ENV !== "production") setRoster(athletes);
      })
      .catch(() => { if (process.env.NODE_ENV !== "production") setRoster(athletes); });
    void apiRequest<{ data: Array<Record<string, unknown>> }>("/api/v1/manage/meets")
      .then((response) => {
        const upcoming = (response.data ?? [])
          .filter((record) => !record.startsOn || String(record.startsOn) >= new Date().toISOString().slice(0, 10))
          .sort((a, b) => String(a.startsOn ?? "").localeCompare(String(b.startsOn ?? "")))[0];
        if (upcoming) setMeet({ name: String(upcoming.name ?? "Competição"), startsOn: String(upcoming.startsOn ?? ""), pool: String(upcoming.pool ?? "50 m"), priority: String(upcoming.priority ?? "A"), qualified: upcoming.qualified == null ? undefined : Number(upcoming.qualified), entries: upcoming.entries == null ? undefined : Number(upcoming.entries) });
        else setMeet({ name: demoMeets[0].name, startsOn: new Date(Date.now() + demoMeets[0].days * 86_400_000).toISOString().slice(0, 10), pool: `${demoMeets[0].location} · Piscina ${demoMeets[0].pool}`, priority: demoMeets[0].priority, qualified: demoMeets[0].qualified, entries: demoMeets[0].entries });
      })
      .catch(() => setMeet({ name: demoMeets[0].name, startsOn: new Date(Date.now() + demoMeets[0].days * 86_400_000).toISOString().slice(0, 10), pool: `${demoMeets[0].location} · Piscina ${demoMeets[0].pool}`, priority: demoMeets[0].priority, qualified: demoMeets[0].qualified, entries: demoMeets[0].entries }));
    void apiRequest<{ data: Array<Record<string, unknown>> }>("/api/v1/manage/videos")
      .then((response) => setVideoSummary({ total: response.data.length, pending: response.data.filter((video) => String(video.status ?? "").toLowerCase() !== "reviewed").length }))
      .catch(() => setVideoSummary({ total: 0, pending: 0 }));
    void apiRequest<AutomationSnapshot>("/api/v1/coach/automation").then(setAutomation).catch(() => setAutomation(null));
    void apiRequest<TodayAnalytics>("/api/v1/analytics/overview?weeks=8").then(setAnalytics).catch(() => setAnalytics(null));
  }, [liveVersion]);

  const displayAthletes = roster ?? [];
  const visibleCount = Math.min(displayAthletes.length, 4);
  const hiddenCount = Math.max(0, displayAthletes.length - visibleCount);
  const daysToMeet = meet?.startsOn ? Math.max(0, Math.round((new Date(meet.startsOn).getTime() - Date.now()) / 86_400_000)) : null;
  const weeklyVolumeM = displayAthletes.reduce((sum, athlete) => sum + athlete.weeklyDistance, 0);
  const readinessValues = displayAthletes.flatMap((athlete) => typeof athlete.readiness === "number" ? [athlete.readiness] : []);
  const readinessAverage = readinessValues.length ? Math.round(readinessValues.reduce((sum, value) => sum + value, 0) / readinessValues.length) : null;
  const readyCount = readinessValues.filter((value) => value >= 70).length;
  const attentionCount = readinessValues.filter((value) => value < 70).length;
  const attendanceAverage = displayAthletes.length ? Math.round(displayAthletes.reduce((sum, athlete) => sum + athlete.attendance, 0) / displayAthletes.length) : null;
  const automationQueue = automation?.proposals.slice().sort((a, b) => ({ CRITICAL: 0, HIGH: 1, OPPORTUNITY: 2, MEDIUM: 3 }[a.priority] - { CRITICAL: 0, HIGH: 1, OPPORTUNITY: 2, MEDIUM: 3 }[b.priority])) ?? [];
  const chartSeries = analytics?.weekly ?? [];
  const chartMax = Math.max(1, ...chartSeries.flatMap((week) => [week.plannedMeters, week.completedMeters]));
  const automationSubtitle = automation ? `${automation.counts.requiringApproval} aguardam aprovação · ${automation.counts.critical + automation.counts.high} prioritárias` : "Calculando sinais do programa";

  const refreshAutomation = async () => {
    setAutomationBusy("recompute");
    try {
      const result = await apiRequest<AutomationSnapshot>("/api/v1/coach/automation/recompute", { method: "POST" });
      setAutomation(result); onNotify("Programa recalculado com os dados mais recentes.");
    } catch (error) { onNotify(error instanceof Error ? error.message : "Não foi possível recalcular o programa."); }
    finally { setAutomationBusy(null); }
  };
  const decideAutomation = async (proposal: AutomationProposal, decision: "approve" | "dismiss") => {
    setAutomationBusy(proposal.id);
    try {
      const response = await apiRequest<{ message?: string } | AutomationProposal>(`/api/v1/coach/automation/proposals/${proposal.id}/${decision}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision === "dismiss" ? { reason: "Plano mantido após revisão da comissão técnica." } : {}),
      });
      setAutomation(await apiRequest<AutomationSnapshot>("/api/v1/coach/automation"));
      onNotify("message" in response && response.message ? response.message : "Decisão técnica registrada.");
    } catch (error) { onNotify(error instanceof Error ? error.message : "Não foi possível registrar a decisão."); }
    finally { setAutomationBusy(null); }
  };

  const exportDailyReport = () => {
    const rows = [csvRow(["Indicador", "Valor"]), csvRow(["Atletas ativos", displayAthletes.length]), csvRow(["Volume semanal", `${(weeklyVolumeM / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`]), csvRow(["Readiness médio", readinessAverage ?? "sem dados"]), csvRow(["Presença", attendanceAverage == null ? "sem dados" : `${attendanceAverage}%`]), csvRow(["Provas filmadas", videoSummary.total])];
    downloadFile(`relatorio-operacional-${new Date().toISOString().slice(0, 10)}.csv`, rows.join("\n"));
    onNotify("Relatório operacional exportado em CSV.");
  };
  return <>
    <PageTitle kicker={today?.kicker ?? "CARREGANDO…"} title={today?.greeting ?? "Bom dia, Leonardo."} subtitle={automation ? `${automation.counts.critical + automation.counts.high} sinais prioritários e ${automation.counts.opportunity} oportunidade de progressão foram recalculados.` : "Recalculando o estado operacional da equipe…"}>
      <button className="secondary-button" onClick={exportDailyReport}><Download size={17} />Relatório</button><button className="primary-button" onClick={onCreate}><Plus size={17} />Novo treino</button>
    </PageTitle>
    <section className="hero-grid">
      {meet && <article className="next-meet-card">
        <div className="meet-top"><span className="priority">PRIORIDADE {meet.priority}</span><Trophy size={18} /></div>
        <div><span>PRÓXIMA COMPETIÇÃO</span><h2>{meet.name}</h2><p><MapPin size={14} />{meet.pool ?? "Piscina 50 m"}</p></div>
        <div className="meet-countdown"><strong>{daysToMeet ?? "—"}</strong><span>dias</span><div><b>{meet.qualified ?? "—"}</b> atletas com índice<br /><b>{meet.entries ?? "—"}</b> provas inscritas</div></div>
        <button onClick={() => onNavigate("seasons")}>Abrir competição <ArrowRight size={16} /></button>
      </article>}
      <div className="metric-grid">
        <Metric label="ATLETAS ATIVOS" value={displayAthletes.length ? String(displayAthletes.length) : "—"} detail={displayAthletes.length ? `${displayAthletes.length} no plantel` : "carregando"} icon={Users} />
        <Metric label="READINESS MÉDIO" value={readinessAverage == null ? "—" : `${readinessAverage} / 100`} detail={`${readyCount} prontos · ${attentionCount} em atenção`} icon={Gauge} tone="violet" />
        <Metric label="PRESENÇA" value={attendanceAverage == null ? "—" : `${attendanceAverage}%`} detail="Média do plantel ativo" icon={CircleCheck} tone="blue" />
        <Metric label="PROVAS FILMADAS" value={String(videoSummary.total)} detail={`${videoSummary.pending} aguardam revisão`} icon={Film} tone="orange" />
      </div>
    </section>
    <section className="today-layout">
      <div className="stack">
        <article className="card action-card">
          <SectionHead title="Treino do dia" subtitle="Crie do seu jeito. A estrutura aparece automaticamente." />
          <div className="create-options">
            <button onClick={onCreate}><span className="option-icon aqua"><MessageSquare size={20} /></span><div><strong>Escrever ou ditar treino</strong><small>Texto livre, voz, foto ou documento</small></div><ArrowRight size={17} /></button>
            <button onClick={() => onNavigate("practices")}><span className="option-icon violet"><Library size={20} /></span><div><strong>Usar a biblioteca</strong><small>Treinos de natação e força</small></div><ArrowRight size={17} /></button>
            <button onClick={onCreate}><span className="option-icon coral"><Sparkles size={20} /></span><div><strong>Criar com o assistente</strong><small>Objetivo, carga e grupo como contexto</small></div><ArrowRight size={17} /></button>
          </div>
        </article>
        <DailyWater onAthlete={onAthlete} />
      </div>
      <aside className="stack">
        <ReadinessPanel compact />
        <article className="card load-card">
          <SectionHead title="Carga da equipe" subtitle="Últimas 8 semanas" action="Analisar" onAction={() => onNavigate("analytics")} />
          <div className="mini-bars dynamic-bars">{chartSeries.map((week, index) => <span className="load-week" key={`${week.label}-${index}`} title={`${week.label}: ${formatNumber(week.completedMeters)} m realizados`}><i className="load-plan" style={{ height: `${Math.max(3, week.plannedMeters / chartMax * 100)}%` }} /><i className="load-done" style={{ height: `${Math.max(3, week.completedMeters / chartMax * 100)}%` }} /><small>{week.label}</small></span>)}</div>
          <div className="load-summary"><div><small>PLANEJADO</small><b>{formatNumber(analytics?.metrics.plannedMeters ?? 0)} m</b></div><div><small>REALIZADO</small><b>{formatNumber(analytics?.metrics.completedMeters ?? 0)} m</b></div><div><small>ADERÊNCIA</small><b>{analytics?.metrics.adherence == null ? "—" : `${analytics.metrics.adherence.toFixed(1).replace(".", ",")}%`}</b></div></div>
          <p className="demo-caption"><Activity size={13} />Métricas recalculadas a partir de prescrições e execuções registradas.</p>
        </article>
      </aside>
    </section>
  </>;
}

export function Team({ onInvite, onAthlete, onNotify, liveVersion = 0 }: { onInvite: () => void; onAthlete: (id: string) => void; onNotify: (message: string) => void; liveVersion?: number }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("Todos");
  const [roster, setRoster] = useState<AthleteProfile[]>(athletes);
  const importInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void apiRequest<{ data: Array<Record<string, unknown>> }>("/api/v1/manage/athletes")
      .then((response) => setRoster(response.data.map(hydrateAthlete)))
      .catch(() => setRoster(athletes));
  }, [liveVersion]);
  const handleImport = async (file?: File) => { if (!file) return; try { const result = await importFile(file, "athletes"); onNotify(`${result.imported} atleta(s) importado(s) com sucesso.`); } catch (error) { onNotify(error instanceof Error ? error.message : "Falha na importação"); } };
  const activeRoster = roster.filter((athlete) => athlete.account === "active");
  const readinessValues = activeRoster.flatMap((athlete) => typeof athlete.readiness === "number" ? [athlete.readiness] : []);
  const sleepValues = activeRoster.flatMap((athlete) => typeof athlete.sleep === "number" ? [athlete.sleep] : []);
  const volume = activeRoster.reduce((sum, athlete) => sum + athlete.weeklyDistance, 0);
  const list = roster.filter((athlete) => {
    const matchesSearch = `${athlete.name} ${athlete.handle} ${athlete.group}`.toLowerCase().includes(query.toLowerCase());
    const matchesFilter = filter === "Todos" || (filter === "Com índice" && Boolean(athlete.goalEvent)) || (filter === "Atenção" && (athlete.readiness ?? 0) < 65) || (filter === "Sem conta" && athlete.account !== "active");
    return matchesSearch && matchesFilter;
  });
  return <>
    <PageTitle kicker="EQUIPE" title="Plantel e prontuários" subtitle="Acompanhe performance, recuperação, objetivos e evolução individual.">
      <input ref={importInput} hidden type="file" accept=".csv,.json,.xlsx,.zip" onChange={(event) => void handleImport(event.target.files?.[0])} /><button className="secondary-button" onClick={() => importInput.current?.click()}><Upload size={17} />Importar</button><button className="primary-button" onClick={onInvite}><UserPlus size={17} />Convidar atleta</button>
    </PageTitle>
    <div className="metric-grid team-metrics"><Metric label="ATLETAS ATIVOS" value={String(activeRoster.length)} detail={`${roster.length - activeRoster.length} sem acesso ativo`} icon={Users} /><Metric label="READINESS" value={readinessValues.length ? String(Math.round(readinessValues.reduce((sum, value) => sum + value, 0) / readinessValues.length)) : "—"} detail={readinessValues.length ? `${readinessValues.filter((value) => value >= 70).length} prontos · ${readinessValues.filter((value) => value < 70).length} em atenção` : "Sem dados de corpo"} icon={HeartPulse} tone="violet" /><Metric label="SONO" value={sleepValues.length ? `${(sleepValues.reduce((sum, value) => sum + value, 0) / sleepValues.length).toFixed(1).replace(".", ",")} h` : "—"} detail="Média dos atletas com wearable" icon={Moon} tone="blue" /><Metric label="VOLUME" value={`${(volume / 1000).toFixed(1).replace(".", ",")} km`} detail="Semana atual · dados sincronizados" icon={Waves} tone="orange" /></div>
    <section className="card roster-card">
      <div className="roster-toolbar"><div className="local-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar nome ou @usuário" /></div><div className="filter-pills">{["Todos", "Com índice", "Atenção", "Sem conta"].map((item) => <button className={filter === item ? "active" : ""} key={item} onClick={() => setFilter(item)}>{item}</button>)}</div><button className="icon-button" aria-label="Aplicar filtro de atenção" onClick={() => { setFilter("Atenção"); onNotify("Filtro de risco aplicado: readiness abaixo de 65."); }}><SlidersHorizontal size={18} /></button></div>
      <div className="roster-head"><span>ATLETA</span><span>OBJETIVO</span><span>READINESS</span><span>SEMANA</span><span>PRESENÇA</span><span /></div>
       <div className="roster-list">{list.map((athlete) => <button className="athlete-row" data-athlete-id={athlete.id} key={athlete.id} onClick={() => onAthlete(athlete.id)}>
        <span className="athlete-person"><Avatar initials={athlete.initials} color={athlete.color} /><span><b>{athlete.name}</b><small>{athlete.handle} · {athlete.group}</small></span>{athlete.account !== "active" && <i>{athlete.account === "invited" ? "Convite pendente" : "Sem conta"}</i>}</span>
        <span>{athlete.goalEvent ? <><b>{athlete.goalEvent}</b><small>{athlete.bestTime} → {athlete.goalTime}</small></> : <><b className="muted">Sem meta</b><small>Cadastre um objetivo</small></>}</span>
        <span>{athlete.readiness ? <><ProgressRing value={athlete.readiness} size="small" /><small>{athlete.lastBodySync}</small></> : <><StatusDot tone="muted" /><small>Sem wearable</small></>}</span>
        <span><b>{formatNumber(athlete.weeklyDistance)} m</b>{athlete.previousDistance > 0 ? <small className={athlete.weeklyDistance >= athlete.previousDistance ? "positive" : "negative"}>{athlete.weeklyDistance >= athlete.previousDistance ? "↑" : "↓"} {Math.abs(Math.round((athlete.weeklyDistance / athlete.previousDistance - 1) * 100))}%</small> : <small className="muted">sem histórico</small>}</span>
        <span><b>{athlete.attendance}%</b><span className="inline-progress"><i style={{ width: `${athlete.attendance}%` }} /></span></span><ArrowRight size={16} />
      </button>)}</div>
    </section>
  </>;
}

export function AthleteDetail({ athlete, onBack, onCreate, onNavigate, onNotify }: { athlete: (typeof athletes)[number]; onBack: () => void; onCreate: () => void; onNavigate: (view: AppView) => void; onNotify: (message: string) => void }) {
  const [panel, setPanel] = useState<AthletePanel>(null);
  const [goal, setGoal] = useState(() => initialGoalFor(athlete));
  useEffect(() => {
    void apiRequest<{ data: Array<Record<string, unknown>> }>(`/api/v1/manage/goals?q=${encodeURIComponent(athlete.id)}`)
      .then((response) => {
        const record = response.data.find((item) => item.athleteId === athlete.id);
        if (!record) return;
        setGoal({
          event: String(record.event ?? ""), course: String(record.course ?? "Piscina 50 m"),
          currentTime: String(record.currentTime ?? ""), targetTime: String(record.targetTime ?? ""),
          meet: String(record.meet ?? ""), deadline: String(record.deadline ?? ""),
          priority: String(record.priority ?? "A"), gap: String(record.gap ?? "A calcular"),
        });
      }).catch(() => undefined);
  }, [athlete.id]);
  const pacing = calculateGoalPacing(athlete, goal);
  const exportPerformance = () => {
    exportAthletePerformance(athlete, goal);
    onNotify("Volume e intensidade exportados em CSV.");
  };
  const exportPdf = () => {
    window.open(`${API_URL}/api/v1/reports/athletes/${athlete.id}.pdf`, "_blank", "noopener,noreferrer");
    onNotify("Relatório RKF em PDF gerado pelo backend.");
  };
  return <>
    <button className="back-button" onClick={onBack}><ChevronLeft size={17} />Voltar para equipe</button>
    <div className="athlete-hero">
      <div className="athlete-identity"><Avatar initials={athlete.initials} color={athlete.color} /><div><span className="eyebrow">{athlete.group}</span><h1>{athlete.name}</h1><p>{athlete.handle} · {athlete.age} anos · Especialista em {athlete.stroke}</p></div></div>
      <div className="athlete-hero-actions"><button className="secondary-button" onClick={() => window.location.assign("/pt/athlete/home")}><Smartphone size={17} />Área do atleta</button><button className="secondary-button" onClick={() => setPanel("message")}><MessageSquare size={17} />Mensagem</button><button className="primary-button" onClick={onCreate}><Plus size={17} />Atribuir treino</button></div>
    </div>
    <section className="athlete-dashboard">
      <div className="stack">
        <article className="card goal-card">
          <SectionHead title="Caminho até o objetivo" subtitle={`Meta individual | ${goal.course}`} action={goal.event ? "Editar meta" : "Criar meta"} onAction={() => setPanel("goal")} />
          {goal.event ? <><div className="goal-route"><div><small>PROVA-META</small><strong>{goal.event}</strong><span>{goal.meet} | prioridade {goal.priority}</span></div><div className="time-node"><small>MARCA ATUAL</small><b>{goal.currentTime}</b></div><div className="route-line"><i style={{ width: "72%" }} /><span>evolução monitorada</span></div><div className="time-node target"><small>META</small><b>{goal.targetTime}</b></div></div><div className="goal-gap"><Target size={18} /><span>Distância atual</span><strong>{goal.gap}</strong><small>Data limite: {goal.deadline.split("-").reverse().join("/")}</small></div>
          {pacing && <div className={`goal-pacing ${pacing.status}`}>
            <div className="pacing-verdict"><span className="pacing-flag" /><div><b>{pacing.label}</b><small>{pacing.advice}</small></div></div>
            <dl className="pacing-figures">
              <div><dt>Faltam</dt><dd>{pacing.weeksLeft} sem</dd></div>
              <div><dt>Ritmo necessário</dt><dd>{pacing.requiredPerWeek.toFixed(2)} s/sem</dd></div>
              <div><dt>Ritmo observado</dt><dd>{pacing.observedPerWeek.toFixed(2)} s/sem</dd></div>
              <div><dt>Projeção</dt><dd>{pacing.projectedTime}</dd></div>
            </dl>
            <p className="demo-caption"><Sparkles size={13} />Projeção RKF em validação. A decisão final permanece com o treinador.</p>
          </div>}</> : <div className="empty-state"><Target size={27} /><strong>Nenhum objetivo definido</strong><p>Cadastre uma prova e uma marca para iniciar o acompanhamento.</p><button className="secondary-button" onClick={() => setPanel("goal")}>Criar objetivo</button></div>}
        </article>
        <article className="card">
          <SectionHead title="Cinco habilidades" subtitle="Evidências de prova + treino | confiança média de 84%" action="Ver metodologia" onAction={() => setPanel("methodology")} />
          <div className="skill-grid">{athlete.skills.map((skill) => <div className="skill-card" key={skill.key}><div><span>{skill.key}</span><small>{skill.label}</small></div><strong>{skill.score}</strong><span className={skill.trend >= 0 ? "positive" : "negative"}>{skill.trend >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{Math.abs(skill.trend)}</span><div className="skill-bar"><i style={{ width: `${skill.score}%` }} /></div></div>)}</div>
          <div className="supporting-proof"><Sparkles size={18} /><div><span>O QUE SUSTENTA O NÍVEL</span><b>Ritmo sustentado nos últimos 3 x 100 da prova</b><small>Vídeo de 23 ago + treino AN2 de 25 ago | consistência alta</small></div><button className="text-button" onClick={() => setPanel("evidence")}>Ver evidências <ArrowRight size={15} /></button></div>
        </article>
        <article className="card volume-panel"><SectionHead title="Volume e intensidade" subtitle="Últimas 8 semanas" action="Exportar CSV" onAction={exportPerformance} /><div className="volume-chart">{[52, 66, 61, 72, 78, 69, 86, 81].map((height, index) => <div key={index}><span style={{ height: `${height}%` }} className={index === 7 ? "current" : ""} /><small>S{index + 1}</small></div>)}</div><div className="zone-stack">{zoneDistribution.map((zone) => <span key={zone.code} style={{ width: `${zone.percent}%`, background: zone.color }} title={`${zone.code}: ${zone.percent}%`} />)}</div><div className="zone-legend">{zoneDistribution.map((zone) => <span key={zone.code}><i style={{ background: zone.color }} />{zone.code} {zone.percent}%</span>)}</div><div className="export-footnote"><Download size={14} /><span>O arquivo inclui prescrito, realizado, aderência e metros por zona.</span><button className="text-button" onClick={exportPdf}><FileText size={14} />Relatório PDF</button></div></article>
      </div>
      <aside className="stack">
        <article className="card body-card"><SectionHead title="Corpo e prontidão" subtitle={athlete.lastBodySync ?? "Sem sincronização"} action="Detalhes" onAction={() => setPanel("body")} />{athlete.readiness ? <><div className="body-overview"><ProgressRing value={athlete.readiness} label="PRONTO" size="large" /><div><span><Moon size={16} /><small>SONO</small><b>{athlete.sleep} h</b></span><span><HeartPulse size={16} /><small>RECUPERAÇÃO</small><b>{athlete.recovery}%</b></span></div></div><div className="body-grid"><div><small>HRV</small><b>{athlete.hrv} ms</b><span className="positive">↑ 4%</span></div><div><small>FCR</small><b>{athlete.restingHr} bpm</b><span>estável</span></div><div><small>SNC</small><b>Bom</b><span>sem alerta</span></div><div><small>MOTOR</small><b>92%</b><span className="positive">ótimo</span></div></div></> : <div className="empty-state compact"><Watch size={26} /><strong>Sem dados de corpo</strong><p>Conecte um wearable para sono, HRV e recuperação.</p><button className="secondary-button" onClick={() => onNavigate("integrations")}>Conectar dispositivo</button></div>}</article>
        <article className="card"><SectionHead title="Próximos treinos" subtitle="Prescrição individual" action="Calendário" onAction={() => onNavigate("practices")} /><div className="compact-sessions">{practices.slice(0, 3).map((practice) => <div key={practice.id}><span className={`practice-kind ${practice.type}`}>{practice.type === "swim" ? <Waves size={16} /> : <Dumbbell size={16} />}</span><div><b>{practice.title}</b><small>{practice.day} · {practice.time} · {practice.distance ? `${formatNumber(practice.distance)} m` : "55 min"}</small></div><span className={`zone-tag ${practice.zone.toLowerCase()}`}>{practice.zone}</span></div>)}</div></article>
        <article className="card"><SectionHead title="Presença e consistência" subtitle="Últimos 30 dias" /><div className="attendance-score"><strong>{athlete.attendance}%</strong><div><b>{Math.round(athlete.attendance / 4)} de 25 sessões</b><small>Presença no ciclo atual</small></div></div><div className="attendance-dots">{Array.from({ length: 25 }, (_, index) => <i key={index} className={index < Math.round(athlete.attendance / 4) ? "done" : index % 7 === 0 ? "missed" : "planned"} />)}</div></article>
      </aside>
    </section>
    {panel === "goal" && <GoalEditor athlete={athlete} goal={goal} onClose={() => setPanel(null)} onSaved={setGoal} onNotify={onNotify} />}
    {panel === "methodology" && <MethodologyDialog athlete={athlete} onClose={() => setPanel(null)} />}
    {panel === "evidence" && <EvidenceDialog athlete={athlete} onClose={() => setPanel(null)} onNotify={onNotify} />}
    {panel === "body" && <BodyReadinessDialog athlete={athlete} onClose={() => setPanel(null)} />}
    {panel === "message" && <AthleteMessageDialog athlete={athlete} onClose={() => setPanel(null)} onNotify={onNotify} />}
  </>;
}

type PublishedWorkoutRecord = { id: string; title?: string; status?: string; date?: string; scheduledAt?: string; distanceMeters?: number; zone?: string; kind?: string; target?: string; athleteId?: string; source?: string; prescriptionText?: string; blocks?: string[] };

export function Practices({ onCreate, onNotify, refreshToken = 0 }: { onCreate: (seed?: WorkoutSeed) => void; onNotify: (message: string) => void; refreshToken?: number }) {
  const [tab, setTab] = useState<"day" | "week" | "mesocycles" | "macrocycles" | "swim" | "strength">("week");
  const [editor, setEditor] = useState<{ initial?: WorkoutSeed } | null>(null);
  const [published, setPublished] = useState<PublishedWorkoutRecord[]>([]);
  const [libraryRecords, setLibraryRecords] = useState<PublishedWorkoutRecord[]>([]);
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  useEffect(() => {
    apiRequest<{ data: PublishedWorkoutRecord[] }>("/api/v1/manage/workouts")
      .then((response) => { setPublished(response.data.filter((item) => item.source === "coach-publish" || item.source === "coach-automation")); setLibraryRecords(response.data.filter((item) => item.source === "library")); })
      .catch(() => { setPublished([]); setLibraryRecords([]); });
  }, [refreshToken, libraryRefresh]);
  return <>
    <PageTitle kicker="PLANEJAMENTO" title="Treinos" subtitle="Prescreva, personalize e publique sem duplicar sessões."><button className="secondary-button" onClick={() => setTab("swim")}><Library size={17} />Bibliotecas</button><button className="primary-button" onClick={() => onCreate()}><Plus size={17} />Criar treino</button></PageTitle>
    <div className="tab-bar"><button className={tab === "day" ? "active" : ""} onClick={() => setTab("day")}>Dia</button><button className={tab === "mesocycles" ? "active" : ""} onClick={() => setTab("mesocycles")}>Mesociclo</button><button className={tab === "macrocycles" ? "active" : ""} onClick={() => setTab("macrocycles")}>Macrociclo</button><button className={tab === "week" ? "active" : ""} onClick={() => setTab("week")}><Calendar size={16} />Microciclo semanal</button><button className={tab === "swim" ? "active" : ""} onClick={() => setTab("swim")}><Waves size={16} />Biblioteca de natação</button><button className={tab === "strength" ? "active" : ""} onClick={() => setTab("strength")}><Dumbbell size={16} />Biblioteca de força</button></div>
    {(tab === "week" || tab === "day") && <WeekCalendar key={tab} dayOnly={tab === "day"} onCreate={onCreate} published={published} />}
    {(tab === "macrocycles" || tab === "mesocycles") && <CycleOverview level={tab} />}
    {tab === "swim" && <LibraryView kind="swim" records={libraryRecords} onUse={onCreate} onEdit={(initial) => setEditor({ initial })} />}
    {tab === "strength" && <LibraryView kind="strength" records={libraryRecords} onUse={onCreate} onEdit={(initial) => setEditor({ initial })} />}
    {editor && <WorkoutTemplateEditor initial={editor.initial} onClose={() => setEditor(null)} onUse={(seed) => { setEditor(null); onCreate(seed); }} onNotify={onNotify} onSaved={() => setLibraryRefresh((value) => value + 1)} />}
  </>;
}

function LegacyWeekCalendar({ onCreate, published }: { onCreate: (seed?: WorkoutSeed) => void; published: PublishedWorkoutRecord[] }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const currentDate = new Date();
  const monday = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate(), 12));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) + weekOffset * 7);
  const base = monday.getTime();
  const todayIso = currentDate.toISOString().slice(0, 10);
  const names = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];
  const months = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const dates = Array.from({ length: 7 }, (_, index) => new Date(base + index * 86_400_000));
  const days = dates.map((date) => {
    const iso = date.toISOString().slice(0, 10);
    const synced = published.filter((record) => record.date === iso).map((record) => ({ id: record.id, date: iso, day: names[date.getUTCDay()], title: record.title ?? "Treino publicado", distance: Number(record.distanceMeters ?? 0), zone: record.zone ?? "A1", type: (record.kind === "strength" ? "strength" : "swim") as "strength" | "swim", time: record.scheduledAt?.slice(11, 16) ?? "08:00", status: "published" as const, group: record.target ?? "Equipe inteira", rpe: 6 }));
    const sessions = [...practices.filter((practice) => practice.date === iso), ...synced];
    return { iso, day: names[date.getUTCDay()], date: String(date.getUTCDate()).padStart(2, "0"), load: Math.round(sessions.reduce((sum, session) => sum + session.distance, 0) / 8), sessions };
  });
  const first = dates[0]; const last = dates[6];
  const weekLabel = `${String(first.getUTCDate()).padStart(2, "0")} ${first.getUTCMonth() !== last.getUTCMonth() ? `de ${months[first.getUTCMonth()]} ` : ""}- ${String(last.getUTCDate()).padStart(2, "0")} de ${months[last.getUTCMonth()]} de ${last.getUTCFullYear()}`;
  const totalLoad = days.reduce((sum, day) => sum + day.load, 0);
  return <section className="card calendar-card"><div className="calendar-toolbar"><div><button className="icon-button" aria-label="Semana anterior" onClick={() => setWeekOffset((value) => value - 1)}><ChevronLeft size={18} /></button><button className="icon-button" aria-label="Próxima semana" onClick={() => setWeekOffset((value) => value + 1)}><ChevronRight size={18} /></button><button className="secondary-button small" onClick={() => setWeekOffset(0)}>Esta semana</button></div><strong>{weekLabel}</strong><div className="week-load"><Sparkles size={15} />Carga prevista <b>{formatNumber(totalLoad)}</b></div></div><div className="week-grid">{days.map((item) => <div className={`day-column ${item.iso === "2026-08-29" ? "today" : ""}`} key={item.iso}><div className="day-head"><span>{item.day}</span><b>{item.date}</b><small>{item.load ? `${item.load} u.a.` : "Descanso"}</small></div><div className="day-content">{item.sessions.length ? item.sessions.map((practice) => <button className={`practice-card ${practice.type}`} key={practice.id} onClick={() => onCreate({ title: practice.title, prompt: `${practice.title}\n${practice.distance ? `${practice.distance} m` : "Sessão de força"}\n${practice.group}`, distanceMeters: practice.distance, zone: practice.zone, kind: practice.type === "strength" ? "strength" : "swim" })}><span><i />{practice.time}</span><strong>{practice.title}</strong><small>{practice.distance ? `${formatNumber(practice.distance)} m` : "55 min"} · {practice.group}</small><div><span className={`zone-tag ${practice.zone.toLowerCase()}`}>{practice.zone}</span><em>{practice.status === "published" ? <><CircleCheck size={12} />Publicado</> : "Rascunho"}</em></div></button>) : <button className="empty-day" onClick={() => onCreate()}><Plus size={17} />Planejar o dia</button>}</div></div>)}</div><div className="calendar-footer"><div><span><i className="swim-dot" />Natação</span><span><i className="strength-dot" />Força</span><span><i className="draft-dot" />Rascunho</span></div><p><Sparkles size={14} />Carga calculada pelo RkfLoadEngine V5.1</p></div></section>;
}

function WeekCalendar({ onCreate, published, dayOnly = false }: { onCreate: (seed?: WorkoutSeed) => void; published: PublishedWorkoutRecord[]; dayOnly?: boolean }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [singleDay, setSingleDay] = useState(dayOnly);
  const [dayOffset, setDayOffset] = useState(0);
  const current = new Date();
  const monday = new Date(Date.UTC(current.getFullYear(), current.getMonth(), current.getDate(), 12));
  monday.setUTCDate(monday.getUTCDate() + (singleDay ? dayOffset : -((monday.getUTCDay() + 6) % 7) + weekOffset * 7));
  const names = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];
  const monthNames = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const todayIso = [current.getFullYear(), String(current.getMonth()+1).padStart(2,"0"), String(current.getDate()).padStart(2,"0")].join("-");
  const days = Array.from({ length: singleDay ? 1 : 7 }, (_, index) => {
    const date = new Date(monday.getTime() + index * 86_400_000);
    const iso = date.toISOString().slice(0, 10);
    const synced = published.filter((record) => record.date === iso).map((record) => ({ id: record.id, persistedId: record.id, title: record.title ?? "Treino publicado", distance: Number(record.distanceMeters ?? 0), zone: record.zone ?? "A1", type: record.kind === "strength" ? "strength" as const : "swim" as const, time: record.scheduledAt?.slice(11, 16) ?? "08:00", scheduledAt: record.scheduledAt ?? `${iso}T08:00`, status: record.status === "published" ? "published" as const : "draft" as const, group: record.target ?? (record.athleteId ? `Individual · ${record.athleteId}` : "Equipe inteira"), prompt: record.prescriptionText ?? "Sessão registrada na agenda.", source: record.source }));
    const sessions = synced;
    return { iso, day: names[date.getUTCDay()], date: String(date.getUTCDate()).padStart(2, "0"), month: monthNames[date.getUTCMonth()], sessions, load: sessions.reduce((sum, session) => sum + session.distance, 0) };
  });
  const first = days[0]; const last = days[days.length-1];
  const weekLabel = `${first.date} ${first.month === last.month ? "" : `de ${first.month} `}- ${last.date} de ${last.month} de ${new Date(monday).getUTCFullYear()}`;
  const totalLoad = days.reduce((sum, day) => sum + day.load, 0);
  return <section className="card calendar-card">
    <div className="calendar-toolbar"><div><button className="icon-button" aria-label={singleDay ? "Dia anterior" : "Semana anterior"} onClick={() => singleDay ? setDayOffset(v => v - 1) : setWeekOffset(v => v - 1)}><ChevronLeft size={18} /></button><button className="icon-button" aria-label={singleDay ? "Próximo dia" : "Próxima semana"} onClick={() => singleDay ? setDayOffset(v => v + 1) : setWeekOffset(v => v + 1)}><ChevronRight size={18} /></button><button className="secondary-button small" onClick={() => { setWeekOffset(0); setDayOffset(0); setSingleDay(v => !v); }}>{singleDay ? "Microciclo semanal" : "Dia"}</button></div><strong>{weekLabel}</strong><div className="week-load"><Sparkles size={15} />Volume previsto <b>{formatNumber(totalLoad)} m</b></div></div>
    <div className={`week-grid ${singleDay ? "single-day" : ""}`}>{days.map((day) => <div className={`day-column ${day.iso === todayIso ? "today" : ""}`} key={day.iso}><div className="day-head"><span>{day.day}</span><b>{day.date}</b><small>{day.load ? `${formatNumber(day.load)} m` : "Descanso"}</small></div><div className="day-content">{day.sessions.length ? day.sessions.map((session) => <button className={`practice-card ${session.type}`} key={session.id} onClick={() => onCreate({ id: session.id, persistedId: session.persistedId, title: session.title, prompt: session.prompt, distanceMeters: session.distance, zone: session.zone, kind: session.type, scheduledAt: session.scheduledAt, target: session.group, source: session.source })}><span><i />{session.time}</span><strong>{session.title}</strong><small>{session.distance ? `${formatNumber(session.distance)} m` : "55 min"} · {session.group}</small><div><span className={`zone-tag ${session.zone.toLowerCase()}`}>{session.zone}</span><em>{session.status === "published" ? <><CircleCheck size={12} />Publicado</> : "Rascunho"}</em></div></button>) : <button className="empty-day" aria-label={`Planejar ${day.day}, ${day.date} de ${day.month}`} onClick={() => onCreate({ title: `Sessão de ${day.day.toLowerCase()} · ${day.date}/${String(new Date(`${day.iso}T12:00:00`).getMonth() + 1).padStart(2, "0")}`, prompt: "", distanceMeters: 0, zone: "A1", kind: "swim", scheduledAt: `${day.iso}T08:00`, target: "Equipe inteira" })}><Plus size={17} />Planejar o dia</button>}</div></div>)}</div>
    <div className="calendar-footer"><div><span><i className="swim-dot" />Natação</span><span><i className="strength-dot" />Força</span><span><i className="draft-dot" />Rascunho</span></div><p><Sparkles size={13} />Volume das sessões cadastradas; carga disponível em Análise</p></div>
  </section>;
}

function LibraryView({ kind, records, onUse, onEdit }: { kind: "swim" | "strength"; records: PublishedWorkoutRecord[]; onUse: (seed: WorkoutSeed) => void; onEdit: (initial?: WorkoutSeed) => void }) {
  const staticItems = (kind === "swim" ? workoutLibrary.map((item) => ({ id: item.id, title: item.title, distanceMeters: item.distance, zone: item.zone, kind: "swim", prompt: item.blocks.join("\n"), lines: item.blocks, meta: `${formatNumber(item.distance)} m · ${item.duration}` })) : strengthLibrary.map((item) => ({ id: item.id, title: item.title, distanceMeters: 0, zone: "FORÇA", kind: "strength", prompt: item.exercises.join("\n"), lines: item.exercises, meta: `${item.duration} · ${item.tonnage}` }))) as Array<{ id: string; title: string; distanceMeters: number; zone: string; kind: string; prompt: string; lines: string[]; meta: string }>;
  const dynamicItems = records.filter((record) => (record.kind ?? "swim") === kind).map((record) => ({ id: record.id, title: record.title ?? "Modelo sem título", distanceMeters: Number(record.distanceMeters ?? 0), zone: record.zone ?? (kind === "swim" ? "A1" : "FORÇA"), kind, prompt: record.prescriptionText ?? record.blocks?.join("\n") ?? "", lines: record.blocks ?? record.prescriptionText?.split("\n").filter(Boolean) ?? [], meta: kind === "swim" ? `${formatNumber(Number(record.distanceMeters ?? 0))} m · personalizado` : "Modelo personalizado" }));
  const items = [...staticItems.filter((item) => !dynamicItems.some((record) => record.id === item.id)), ...dynamicItems];
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState("");
  const shown = items.filter((item) => `${item.title} ${item.lines.join(" ")}`.toLowerCase().includes(query.toLowerCase()) && (!focus || JSON.stringify(item).toLowerCase().includes(focus.toLowerCase())));
  const focusOptions = kind === "swim" ? zoneDistribution.map((zone) => zone.code) : ["Força máxima", "Potência", "Prevenção", "Core"];
  return <section className="library-layout"><aside className="card library-filters"><b>Filtros</b><label>Buscar</label><div className="local-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome ou conteúdo" /></div><label>{kind === "swim" ? "Zona principal" : "Foco"}</label>{focusOptions.map((item) => <button className={focus === item ? "active" : ""} key={item} onClick={() => setFocus(focus === item ? "" : item)}>{kind === "swim" ? <StatusDot /> : <Dumbbell size={15} />}<span>{item}</span></button>)}</aside><div><SectionHead title={kind === "swim" ? "Biblioteca de natação" : "Biblioteca de força"} subtitle={`${shown.length} modelos prontos para adaptar`} action="Novo modelo" onAction={() => onEdit()} />
      <div className="library-grid">{shown.map((item) => { const seed: WorkoutSeed = { id: item.id, title: item.title, prompt: item.prompt, distanceMeters: item.distanceMeters, zone: item.zone, kind }; return <article className="card library-card" key={item.id}><div className="library-card-top"><span className={`option-icon ${kind === "swim" ? "aqua" : "violet"}`}>{kind === "swim" ? <Waves size={19} /> : <Dumbbell size={19} />}</span><button className="icon-button" aria-label={`Editar ${item.title}`} onClick={() => onEdit(seed)}><MoreHorizontal size={17} /></button></div><h3>{item.title}</h3><p>{item.meta}</p><div className="library-blocks">{item.lines.map((line) => <span key={line}>{line}</span>)}</div><div className="library-card-actions"><button className="secondary-button" onClick={() => onEdit(seed)}>Editar modelo</button><button className="primary-button" onClick={() => onUse(seed)}>Usar no calendário <ArrowRight size={15} /></button></div></article>; })}</div></div></section>;
}
