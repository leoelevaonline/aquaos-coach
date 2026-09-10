"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight, BarChart3, Bell, Calendar, ChevronDown, CircleCheck, Film, Gauge, Home, Inbox, Link2,
  LogOut, Menu, Plus, Search, Settings, SlidersHorizontal, Sparkles, Trophy, Users, Waves,
  Wifi,
} from "lucide-react";
import { athletes, hydrateAthlete, meets, videos, type AthleteProfile } from "./demo-data";
import { Avatar } from "./components";
import { AthleteDetail, Practices, Team, Today, type AppView } from "./views-primary";
import { Analytics, Integrations, News, ProgramSettings, Season, Videos } from "./views-secondary";
import { ConnectionDialog, InviteModal, LiveAnalysisModal, MeetDetail, QuickCreate, VideoReview, WorkoutComposer } from "./modals";
import { ManagementCenter, type ManagementKind } from "./management";
import type { WorkoutSeed } from "./workout-library-actions";
import { AiAssistant } from "./ai-assistant";
import { RkfOperations } from "./rkf-operations";
import { LoadControl, DailyUpdates } from "./coach-panels";
import { PerfectRace, Protocols, WorkoutEntry } from "./coach-planning";
import { AuthGate, SKIP_DEMO_LOGIN_KEY } from "./auth-gate";
import { apiRequest, subscribeToLiveEvents } from "./api";

type Modal = "workout-entry" | "workout" | "invite" | "video" | "meet" | "command" | "manage" | "connection" | "live" | null;

const routes: Record<AppView, string> = {
  today: "/pt/coach/today", athletes: "/pt/coach/athletes", practices: "/pt/coach/practices",
  seasons: "/pt/coach/seasons", videos: "/pt/coach/videos", analytics: "/pt/coach/analytics",
  race: "/pt/coach/perfect-race", protocols: "/pt/coach/protocols", ai: "/pt/coach/assistant", rkf: "/pt/coach/rkf", inbox: "/pt/coach/inbox", integrations: "/pt/coach/integrations", settings: "/pt/coach/settings",
};

const nav: { id: AppView; label: string; icon: LucideIcon; badge?: number }[] = [
  { id: "today", label: "Hoje", icon: Home }, { id: "athletes", label: "Equipe", icon: Users },
  { id: "practices", label: "Treinos", icon: Calendar }, { id: "seasons", label: "Temporada", icon: Trophy },
  { id: "videos", label: "Vídeos", icon: Film, badge: 2 }, { id: "analytics", label: "Análise", icon: BarChart3 },
  { id: "race", label: "Prova Perfeita", icon: Trophy }, { id: "protocols", label: "Protocolos", icon: SlidersHorizontal },
  { id: "inbox", label: "Atualização do Dia", icon: Inbox }, { id: "integrations", label: "Integrações", icon: Link2 },
  { id: "ai", label: "RKF IA", icon: Sparkles },
];

function viewFromPath(pathname: string): AppView {
  if (pathname.includes("/athletes")) return "athletes";
  if (pathname.includes("/practices")) return "practices";
  if (pathname.includes("/seasons") || pathname.includes("/meets")) return "seasons";
  if (pathname.includes("/videos") || pathname.includes("/entries")) return "videos";
  if (pathname.includes("/analytics")) return "analytics";
  if (pathname.includes("/rkf")) return "analytics";
  if (pathname.includes("/perfect-race")) return "race";
  if (pathname.includes("/protocols")) return "protocols";
  if (pathname.includes("/assistant")) return "ai";
  if (pathname.includes("/inbox")) return "inbox";
  if (pathname.includes("/integrations")) return "integrations";
  if (pathname.includes("/settings")) return "settings";
  return "today";
}

function CoachWorkspace() {
  const pathname = usePathname();
  const router = useRouter();
  const view = viewFromPath(pathname);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState("");
  const [search, setSearch] = useState("");
  const [manageKind, setManageKind] = useState<ManagementKind>("athletes");
  const [createManaged, setCreateManaged] = useState(false);
  const [videoId, setVideoId] = useState(videos[0].id);
  const [meetId, setMeetId] = useState(meets[0].id);
  const [connectionProvider, setConnectionProvider] = useState<"garmin" | "polar" | "apple">("garmin");
  const [workoutSeed, setWorkoutSeed] = useState<WorkoutSeed | undefined>();
  const [workoutRefresh, setWorkoutRefresh] = useState(0);
  const [liveVersion, setLiveVersion] = useState(0);
  const [liveStatus, setLiveStatus] = useState<"connecting" | "open" | "error">("connecting");
  const [signingOut, setSigningOut] = useState(false);
  const [managedAthletes, setManagedAthletes] = useState<AthleteProfile[]>(athletes);
  const searchInput = useRef<HTMLInputElement>(null);
  const athleteId = pathname.split("/athletes/")[1]?.split("/")[0];
  const selectedAthlete = managedAthletes.find((athlete) => athlete.id === athleteId);

  const go = (next: AppView) => { router.push(routes[next]); setMobileOpen(false); };
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 3200); };
  const openManage = (kind: ManagementKind = "athletes", create = false) => { setManageKind(kind); setCreateManaged(create); setModal("manage"); };
  const openWorkout = (seed?: WorkoutSeed) => { setWorkoutSeed(seed); setModal(seed?.persistedId ? "workout" : "workout-entry"); };
  const searchResults = search.trim() ? [
    ...managedAthletes.filter((athlete) => `${athlete.name} ${athlete.handle} ${athlete.group}`.toLowerCase().includes(search.toLowerCase())).slice(0, 4).map((athlete) => ({ id: athlete.id, label: athlete.name, detail: athlete.group, action: () => router.push(`${routes.athletes}/${athlete.id}`) })),
    ...nav.filter((item) => item.label.toLowerCase().includes(search.toLowerCase())).slice(0, 3).map((item) => ({ id: item.id, label: item.label, detail: "Módulo", action: () => go(item.id) })),
  ] : [];
  const selectSearch = (action: () => void) => { action(); setSearch(""); };
  const signOut = async () => {
    setSigningOut(true);
    window.sessionStorage.setItem(SKIP_DEMO_LOGIN_KEY, "1");
    try { await apiRequest("/api/v1/auth/logout", { method: "POST" }); }
    catch { /* sessão já pode ter expirado */ }
    finally { window.location.assign("/pt/coach/today"); }
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); searchInput.current?.focus(); }
      if (event.key === "Escape") setSearch("");
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => subscribeToLiveEvents(() => setLiveVersion((value) => value + 1), setLiveStatus), []);
  useEffect(() => {
    void apiRequest<{ data: Array<Record<string, unknown>> }>("/api/v1/manage/athletes")
      .then((response) => setManagedAthletes(response.data.map(hydrateAthlete)))
      .catch(() => setManagedAthletes(athletes));
  }, [liveVersion]);

  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
      <button className="brand" onClick={() => go("today")}>
        <span className="brand-mark"><Waves size={21} /></span>
        <span><strong>RKF <em>Coach</em></strong><small>Alto rendimento</small></span>
      </button>
      <button className="team-switch" onClick={() => openManage("settings")}><span className="team-badge">SN</span><span><strong>Seleção Nacional</strong><small>Programa principal</small></span><ChevronDown size={15} /></button>
      <nav className="main-nav">
        <span className="nav-kicker">OPERAÇÃO</span>
        {nav.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => go(item.id)}><item.icon size={18} /><span>{item.label}</span>{item.badge && <em>{item.badge}</em>}</button>)}
        <span className="nav-kicker nav-spacer">PROGRAMA</span>
        <button onClick={() => openManage()}><SlidersHorizontal size={18} /><span>Central de gestão</span></button>
        <button className={view === "settings" ? "active" : ""} onClick={() => go("settings")}><Settings size={18} /><span>Configurações</span></button>
      </nav>
      <div className="sidebar-footer">
        <div className="demo-notice"><Sparkles size={17} /><span><strong>Método RKF V5.1</strong><small>Núcleo em validação</small></span></div>
        <div className="coach-card"><Avatar initials="LM" color="#d9ece8" small /><span><strong>Leonardo Martins</strong><small>Head coach</small></span></div>
        <button className="coach-logout-button" type="button" onClick={() => void signOut()} disabled={signingOut}><LogOut size={16} />{signingOut ? "Saindo…" : "Sair / trocar perfil"}</button>
      </div>
    </aside>
    {mobileOpen && <button className="scrim" aria-label="Fechar menu" onClick={() => setMobileOpen(false)} />}

    <div className="workspace">
      <header className="topbar">
        <button className="icon-button menu-button" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu size={21} /></button>
        <div className="global-search"><Search size={17} /><input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && searchResults[0]) selectSearch(searchResults[0].action); }} placeholder="Buscar atleta, treino, prova…" aria-label="Busca global" /><kbd>⌘ K</kbd>{search && <div className="global-search-results">{searchResults.length ? searchResults.map((result) => <button key={`${result.detail}-${result.id}`} onClick={() => selectSearch(result.action)}><span><b>{result.label}</b><small>{result.detail}</small></span><ArrowRight size={15} /></button>) : <p>Nenhum atleta ou módulo encontrado.</p>}</div>}</div>
        <div className="top-actions"><div className={`sync-state ${liveStatus === "error" ? "offline" : ""}`}><Wifi size={15} /><span>{liveStatus === "open" ? "Dados em tempo real" : liveStatus === "error" ? "Reconectando dados" : "Conectando dados"}</span></div><button className="icon-button bell-button" onClick={() => go("inbox")} aria-label="Atualização do Dia"><Bell size={19} /><i /></button><button className="secondary-button compact manage-button" onClick={() => openManage()}><SlidersHorizontal size={16} />Gerenciar</button><button className="primary-button compact" onClick={() => setModal("command")}><Plus size={17} />Criar</button></div>
      </header>
      <main className="content">
        {view === "today" && <Today onCreate={() => openWorkout()} onNavigate={go} onAthlete={(id) => router.push(`${routes.athletes}/${id}`)} onNotify={notify} liveVersion={liveVersion} />}
        {view === "athletes" && (selectedAthlete ? <AthleteDetail athlete={selectedAthlete} onBack={() => router.push(routes.athletes)} onCreate={() => openWorkout()} onNavigate={go} onNotify={notify} /> : <Team onInvite={() => setModal("invite")} onAthlete={(id) => router.push(`${routes.athletes}/${id}`)} onNotify={notify} liveVersion={liveVersion} />)}
        {view === "practices" && <Practices onCreate={openWorkout} onNotify={notify} refreshToken={workoutRefresh + liveVersion} />}
        {view === "seasons" && <Season onMeet={(id) => { setMeetId(id); setModal("meet"); }} onSettings={() => go("settings")} onCreateMeet={() => openManage("meets", true)} onNotify={notify} liveVersion={liveVersion} />}
        {view === "videos" && <Videos onVideo={(id) => { setVideoId(id); setModal("video"); }} onLive={() => setModal("live")} onNotify={notify} liveVersion={liveVersion} />}
        {view === "analytics" && <LoadControl />}
        {view === "rkf" && <RkfOperations onNotify={notify} />}
        {view === "inbox" && <DailyUpdates />}
        {view === "race" && <PerfectRace />}
        {view === "protocols" && <Protocols onUse={openWorkout} />}
        {view === "ai" && <AiAssistant embedded />}
        {view === "integrations" && <Integrations onNotify={notify} onCreateConnection={(provider = "garmin") => { setConnectionProvider(provider); setModal("connection"); }} liveVersion={liveVersion} />}
        {view === "settings" && <ProgramSettings onNotify={notify} />}
      </main>
    </div>

    <nav className="mobile-nav">
      {nav.slice(0, 5).map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => go(item.id)}><item.icon size={19} /><span>{item.label}</span></button>)}
    </nav>
    {modal === "workout-entry" && <WorkoutEntry seed={workoutSeed} onClose={() => setModal(null)} onChoose={(seed) => { setWorkoutSeed(seed); setModal("workout"); }} />}
    {modal === "workout" && <WorkoutComposer seed={workoutSeed} onClose={() => { setModal(null); setWorkoutSeed(undefined); }} onSave={() => { const edited = Boolean(workoutSeed?.persistedId); setModal(null); setWorkoutSeed(undefined); setWorkoutRefresh((value) => value + 1); router.push(routes.practices); notify(edited ? "Evento atualizado na agenda sem criar duplicata." : "Treino publicado e salvo no calendário."); }} />}
    {modal === "invite" && <InviteModal onClose={() => setModal(null)} onSave={() => { setModal(null); notify("Convite criado e copiado com segurança."); }} />}
    {modal === "video" && <VideoReview videoId={videoId} onClose={() => setModal(null)} onSave={() => { setModal(null); notify("Revisão técnica salva no prontuário."); }} />}
    {modal === "live" && <LiveAnalysisModal onClose={() => setModal(null)} />}
    {modal === "meet" && <MeetDetail meetId={meetId} onClose={() => setModal(null)} onNotify={notify} />}
    {modal === "command" && <QuickCreate onClose={() => setModal(null)} onSelect={(choice) => { if (choice === "Treino") openWorkout(); else if (choice === "Convite") setModal("invite"); else if (choice === "Vídeo") { setModal(null); go("videos"); } else openManage(choice === "Atleta" ? "athletes" : choice === "Competição" ? "meets" : "goals", true); }} />}
    {modal === "manage" && <ManagementCenter onClose={() => setModal(null)} onNotify={notify} initialKind={manageKind} createOnOpen={createManaged} />}
    {modal === "connection" && <ConnectionDialog initialProvider={connectionProvider} onClose={() => setModal(null)} onSave={notify} />}
    {toast && <div className="toast"><CircleCheck size={18} />{toast}</div>}
    {view !== "ai" && <AiAssistant />}
  </div>;
}

export default function Dashboard() {
  return <AuthGate><CoachWorkspace /></AuthGate>;
}
