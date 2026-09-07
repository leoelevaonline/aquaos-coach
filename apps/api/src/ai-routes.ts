import type { FastifyInstance } from "fastify";
import type { ManagedStore } from "./managed-store.js";
import { getSession, roleAllows, sessionToken } from "./auth.js";

type ChatMessage = { role: "user" | "assistant"; content: string };

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.elevamkt.digital/v1";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const LLM_MODEL = process.env.LLM_MODEL ?? "auto/best-chat";
let statusCache: { checkedAt: number; available: boolean; reason?: string } | undefined;

function esc(value: unknown): string {
  return String(value ?? "—");
}

/**
 * Serializa todo o estado da plataforma em um contexto estruturado para o LLM.
 * O assistente só conhece o que está aqui — então este snapshot deve cobrir
 * todas as entidades visíveis na interface do coach.
 */
export function buildPlatformContext(store: ManagedStore, organizationId = "org-demo"): string {
  const list = (kind: string) => store.list(kind as never).filter((item) => item.organizationId === organizationId);
  const sections: string[] = [];

  const settings = list("settings");
  if (settings.length) {
    const s = settings[0] as Record<string, unknown>;
    sections.push(`## Organização
- Nome: ${esc(s.organizationName)}
- Idioma: ${esc(s.locale)} · Medidas: ${esc(s.measurementSystem)} · Piscina principal: ${esc(s.primaryPool)}
- Motor de carga: ${esc(s.loadEngine)}`);
  }

  const athletes = list("athletes") as Array<Record<string, unknown>>;
  if (athletes.length) {
    sections.push(`## Atletas (${athletes.length})
${athletes.map((a) => `- ${esc(a.name)} (${esc(a.handle)}) · grupo: ${esc(a.group)} · nado: ${esc(a.stroke)} · status: ${esc(a.status)}`).join("\n")}`);
  }

  const groups = list("groups") as Array<Record<string, unknown>>;
  if (groups.length) {
    sections.push(`## Grupos (${groups.length})
${groups.map((g) => `- ${esc(g.name)} · cor: ${esc(g.color)} · membros: ${esc(g.members)} · status: ${esc(g.status)}`).join("\n")}`);
  }

  const workouts = list("workouts") as Array<Record<string, unknown>>;
  if (workouts.length) {
    sections.push(`## Treinos (${workouts.length})
${workouts.map((w) => `- ${esc(w.title)} · data: ${esc(w.date)} · status: ${esc(w.status)} · ${w.distanceMeters ? `${esc(w.distanceMeters)} m` : `${esc(w.durationMinutes)} min`} · zona: ${esc(w.zone)}`).join("\n")}`);
  }

  const seasons = list("seasons") as Array<Record<string, unknown>>;
  if (seasons.length) {
    sections.push(`## Temporadas (${seasons.length})
${seasons.map((s) => `- ${esc(s.name)} · ${esc(s.startsOn)} a ${esc(s.endsOn)} · status: ${esc(s.status)}`).join("\n")}`);
  }

  const meets = list("meets") as Array<Record<string, unknown>>;
  if (meets.length) {
    sections.push(`## Competições (${meets.length})
${meets.map((m) => `- ${esc(m.name)} · data: ${esc(m.startsOn)} · prioridade: ${esc(m.priority)} · piscina: ${esc(m.pool)} · status: ${esc(m.status)}`).join("\n")}`);
  }

  const videos = list("videos") as Array<Record<string, unknown>>;
  if (videos.length) {
    sections.push(`## Vídeos (${videos.length})
${videos.map((v) => `- ${esc(v.title)} · atleta: ${esc(v.athlete)} · evento: ${esc(v.event)} · status: ${esc(v.status)} · análise: ${esc(v.analysisStatus)} · duração: ${esc(v.durationSeconds)}s`).join("\n")}`);
  }

  const staff = list("staff") as Array<Record<string, unknown>>;
  if (staff.length) {
    sections.push(`## Comissão técnica (${staff.length})
${staff.map((s) => `- ${esc(s.name)} · cargo: ${esc(s.role)} · acesso: ${esc(s.access)} · status: ${esc(s.status)}`).join("\n")}`);
  }

  const zones = list("zones") as Array<Record<string, unknown>>;
  if (zones.length) {
    sections.push(`## Zonas de intensidade (${zones.length})
${zones.map((z) => `- ${esc(z.name)} · código: ${esc(z.code)} · ritmo: ${esc(z.pace)} · status: ${esc(z.status)}`).join("\n")}`);
  }

  const goals = list("goals") as Array<Record<string, unknown>>;
  if (goals.length) {
    sections.push(`## Metas (${goals.length})
${goals.map((g) => `- ${esc(g.name)} · prova: ${esc(g.event)} · tempo-alvo: ${esc(g.targetTime)} · status: ${esc(g.status)}`).join("\n")}`);
  }

  const audit = store.audit(100).filter((entry) => (entry.organizationId ?? "org-demo") === organizationId).slice(0, 12);
  if (audit.length) {
    sections.push(`## Atividade recente (auditoria)
${audit.map((entry) => `- ${esc(entry.createdAt)} · ${esc(entry.action)} em ${esc(entry.resource)}: ${esc(entry.summary)}`).join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Snapshot rico de performance — espelha os dados que a interface do coach
 * exibe (prontidão, habilidades, metas, volumes, alertas, conectores).
 */
function buildPerformanceContext(): string {
  return `## Prontidão e corpo (hoje)
- Ana Souza (@anaswim): readiness 86 · sono 8.1h · recuperação 82% · HRV 72ms · FCR 48 · wearable Garmin Fēnix 8 · sincronizado hoje 06:42
- Caio Martins (@caiobfly): readiness 72 · sono 6.8h · recuperação 68% · HRV 59ms · FCR 52 · wearable Polar Vantage V3 · sincronizado hoje 07:03
- Luiza Costa (@luizaback): readiness 58 (ATENÇÃO) · sono 5.9h · recuperação 54% · HRV 46ms · FCR 61 · wearable WHOOP 5.0 · sinc ontem 22:48
- Pedro Lima (@pedrobreast): readiness 79 · sono 7.4h · recuperação 76% · HRV 64ms · FCR 50 · sem wearable
- Gabriel Rocha (@gabrielmedley): readiness 67 · sono 7.0h · convite pendente há 4 dias (sem conta)
- Marina Alves (@marinawater): readiness 63 · sono 6.5h · águas abertas · sem dados corporais

## Metas individuais e distância
- Ana Souza: 200 m Livre · PB 2:01.32 · meta 1:58.50 · gap +2.82 · ritmo necessário 0.94s/sem · ritmo observado 0.50s/sem (abaixo do necessário)
- Caio Martins: 100 m Borboleta · PB 54.18 · meta 52.90 · gap +1.28
- Luiza Costa: 100 m Costas · PB 1:03.86 · meta 1:01.20 · gap +2.66
- Pedro Lima: 200 m Peito · PB 2:15.41 · meta 2:12.00 · gap +3.41 · em queda (−1.08s nas últimas 3 provas)
- Marina Alves: 10 km águas abertas · gap +4:48
- Gabriel Rocha: sem meta cadastrada

## Habilidades técnicas (0-100, com tendência)
- Ana Souza: Saída 78(↑3) · Velocidade 91(↑5) · Virada 74(↓1) · Ritmo 88(↑4) · Chegada 82(↑2)
- Caio Martins: Saída 86(↑4) · Velocidade 88(↑2) · Virada 69(↓2) · Ritmo 76(↑1) · Chegada 71(=)
- Luiza Costa: Saída 66(↓1) · Velocidade 79(↑3) · Virada 63(=) · Ritmo 72(↑2) · Chegada 68(↑1)
- Pedro Lima: Saída 71(=) · Velocidade 82(↑1) · Virada 77(↑3) · Ritmo 75(↑2) · Chegada 73(=)

## Volumes semanais (atual vs anterior)
- Ana Souza: 28.600 m (↑ de 26.400) · presença 96%
- Caio Martins: 27.100 m (↓ de 28.200 — queda de 14%) · presença 91%
- Luiza Costa: 21.200 m (↓ de 24.500) · presença 87%
- Pedro Lima: 23.400 m · presença 93%
- Total da equipe: 148,9 km · meta semanal 155 km · ↑6,8% vs semana passada

## Calendário de treinos (próximos)
- 28/08 SEX 07:30 · Ritmo de prova · 200 Livre · 5.200 m · AN2 · Equipe inteira · RPE 7 · publicado
- 28/08 SEX 16:00 · Força máxima · membros inferiores · 55 min · Elite · RPE 8 · publicado
- 29/08 SÁB 08:00 · Aeróbio regenerativo + técnica · 3.800 m · A1 · Equipe inteira · RPE 4 · rascunho
- 31/08 SEG 06:30 · VO₂ · tolerância ao lactato · 4.600 m · AN1 · Elite · RPE 9 · publicado
- 01/09 TER 07:00 · Base aeróbia · eficiência · 5.800 m · A2 · Equipe inteira · RPE 6 · publicado
- 02/09 QUA 16:30 · Potência e core · FORÇA · Desenvolvimento · RPE 7 · rascunho

## Biblioteca de treinos
Natação: Ritmo de 200 · fechamento forte (5.200m AN2) · Aeróbio específico · eficiência (6.100m A2) · Lactato · velocidade sustentada (4.200m AN1) · Regenerativo técnico (3.200m A1)
Força: Potência de saída (55min, 6.4t) · Estabilidade de ombro (42min, 2.8t) · Força máxima geral (70min, 10.2t)

## Temporada e fases
Temporada Olímpica 2026/27 · 04/08/2026 a 19/07/2027 · semana 4 de 50
Fases: Base geral (04/08–20/09, 45% concluída) · Construção específica (21/09–13/12) · Competição de inverno (14/12–31/01) · Transição (01/02–14/02)

## Competições
- Troféu Brasil - José Finkel · prioridade A · 18/09 (21 dias) · São Paulo · 50m · 4 atletas com índice · 12 inscrições
- Campeonato Estadual Absoluto · prioridade B · 24/10 (57 dias) · Curitiba · 25m · 6 com índice · 19 inscrições
- Open Internacional · prioridade A · 12/12 (106 dias) · Rio de Janeiro · 50m · 2 com índice · 8 inscrições

## Índices do Troféu Brasil (50m)
50 Livre: F 0:26.30 / M 0:23.40 · 100 Livre: F 0:57.20 / M 0:51.60 · 200 Livre: F 2:03.80 / M 1:52.40 · 100 Costas: F 1:04.90 / M 0:57.80 · 100 Peito: F 1:12.40 / M 1:03.20 · 100 Borboleta: F 1:03.10 / M 0:55.90

## Vídeos e análise
- Técnica de crawl · sessão diurna (Ana Souza) · 16,95s · 9 eventos detectados · aguardando revisão
- Ritmo e eficiência · sessão noturna (Caio Martins) · 24,88s · 11 eventos detectados · aguardando revisão
- 200 m Peito (Pedro Lima) · 2:15.41 · revisado
- 100 m Costas (Luiza Costa) · 1:03.86 · revisado
Total: 24 provas filmadas · 2 aguardando revisão · 4 esta semana

## Alertas ativos (inbox)
1. CRÍTICO — Readiness abaixo do padrão: Luiza 18% abaixo da média de 28 dias, sono curto e HRV em queda (há 12 min)
2. ALERTA — Volume caiu 14%: Caio completou 3,9 km menos que a semana anterior (há 36 min)
3. VÍDEO — 2 provas aguardam revisão: Ana e Caio com vídeos sem feedback técnico (há 2h)
4. SUCESSO — Pedro está perto da meta: diferença para 2:12.00 caiu 1,08s nas últimas três provas
5. CONTA — Convite pendente: Gabriel não ativou a conta enviada há 4 dias

## Conectores de dispositivos
Garmin Connect (conectado, 3 atletas, leitura+escrita) · Polar Flow (conectado, 1 atleta, leitura) · WHOOP (conectado, 1 atleta, leitura) · Google Health/Oura/Withings/Strava (prontos para conectar) · Apple Health (nativo, exige app iOS)

## Carga da equipe (últimas 8 semanas)
Aguda 538 · Crônica 504 · ACWR 1,07 (razoável) · aderência à carga 93,4% · presença geral 91% (32/35 sessões) · evolução de PBs: +12 nos últimos 90 dias · cobertura de wearable: 5 de 6`;
}

const SYSTEM_PROMPT = `Você é o assistente de inteligência do RKF Coach, a plataforma de gestão de equipes de natação.

CONTEXTO: você recebe abaixo um snapshot completo e atualizado dos dados da plataforma (dados de gestão + dados de performance). Responda APENAS com base nesses dados.

REGRAS:
1. Responda em português do Brasil, com tom profissional e direto, como um analista de performance experiente conversando com o treinador.
2. Use os dados reais do snapshot: nomes, números, datas, status. Nunca invente atletas, marcas ou treinos.
3. Se o dado não estiver no snapshot, diga explicitamente que não tem essa informação em vez de especular.
4. Seja acionável: quando fizer sentido, sugira o próximo passo (revisar atleta, ajustar treino, checar vídeo).
5. Para perguntas analíticas, calcule com cuidado (médias, somas, comparações) antes de responder.
6. Formate respostas curtas e escaneáveis: use listas quando houver vários itens, negrito para destaques via **texto**.
7. Você pode falar de qualquer tema da plataforma: atletas, prontidão corporal, treinos, biblioteca, temporadas, competições, índices, vídeos, habilidades técnicas, metas, volumes, alertas, conectores, comissão, grupos, zonas e configurações.`;

/**
 * Prompt do treinador-chefe de seleção nacional para a análise de vídeo.
 * O assistente "assiste" ao vídeo através dos dados de rastreamento do
 * AquaVision (pose COCO-17, tracking, braçadas, velocidades) - interpreta
 * evidência objetiva, nunca inventa o que os dados não mostram.
 */
export const VISION_COACH_PROMPT = `Você é o treinador-chefe de uma seleção nacional de natação, com mais de 25 anos de experiência em natação de alto rendimento: biomecânica dos quatro nados e do medley, análise de prova (saídas, viradas, braçadas, chegadas), periodização e preparação de atletas olímpicos.

PAPEL NESTA PLATAFORMA: você analisa vídeos de treino e prova através do rastreamento computacional do motor AquaVision - esqueleto (17 keypoints), identidade e trajetória de cada atleta, braçadas detectadas, cadência, velocidade e distância. Os dados abaixo são a sua "visão" do vídeo.

REGRAS:
1. Responda em português do Brasil, direto e técnico, como falaria com sua comissão na borda da piscina.
2. Interprete APENAS os números fornecidos. Nunca invente atletas, tempos, braçadas ou eventos que não estejam nos dados.
3. Distinga evidência forte de fraca: cobertura e confiança baixas (atleta submerso, câmera de borda) pedem conclusões cautelosas - diga isso explicitamente.
4. Cite os números e os tempos (em segundos) que sustentam cada afirmação.
5. Conecte os indicadores à mecânica do nado: cadência vs. distância por braçada, consistência rítmica, variação de velocidade, assimetrias entre atletas.
6. Prescreva ajustes concretos e priorizados; sem generalidades vazias.
7. As métricas são apoio objetivo: a decisão final é sempre do treinador humano. Nunca presuma diagnósticos clínicos ou médicos.
8. Métrica marcada como "não medido" ou "não validado" não existe para você: declare-a indisponível e não a substitua por estimativa. Valores em pixels nunca devem ser lidos como metros ou m/s.`;

type MetricValidity = "measured" | "unavailable" | "uncalibrated" | "not_validated";

type VisionPersonRecord = {
  id: number; idAliases?: number[]; firstSeen: number; lastSeen: number; durationSeconds: number; strokes: number;
  strokeRate: number; rhythmConsistency: number; avgSpeed: number; maxSpeed: number;
  distance: number; distancePerStroke: number; units?: string; meanConfidence: number;
  coverage: number; strokeSignal?: string | null; strokeTimes?: number[];
  gaps?: Array<{ from: number; to: number }>;
  validity?: Partial<Record<"strokes" | "strokeRate" | "rhythmConsistency" | "avgSpeed" | "maxSpeed" | "distance" | "distancePerStroke", MetricValidity>>;
};

export type VisionAnalysisRecord = {
  engine?: string; engineVersion?: string; methodology?: string;
  metadata?: { durationSeconds?: number; width?: number; height?: number; fps?: number; units?: string; calibrated?: boolean; persons?: number; primaryPersonId?: number; sampleFps?: number; keyframesTruncatedAt?: number | null };
  metrics?: { detectedCycles?: number; estimatedCadence?: number; rhythmConsistency?: number; meanMotion?: number; peakMotion?: number };
  sportMetrics?: { contractVersion: string; metrics: Array<{ id: string; label: string; status: MetricValidity; unit: string; interval: { startSeconds: number; endSeconds: number }; coverage: number; source: string; sourceVersion: string; unavailableReason?: string; value?: number }> };
  timeline?: Array<{ time: number; motion: number }>;
  events?: Array<{ id: string; time: number; category: string; label: string; confidence: number; personId?: number }>;
  people?: VisionPersonRecord[];
  keyframes?: Array<{ t: number; persons: Array<{ id: number; kpts: number[][] }> }>;
};

const UNMEASURED = "não medido";

/** Valor com estado de validade explícito: a IA nunca recebe zero disfarçado de medição. */
function measured(person: VisionPersonRecord, key: NonNullable<VisionPersonRecord["validity"]> extends Partial<Record<infer K, MetricValidity>> ? K : never, value: number | string, unit = ""): string {
  const state = person.validity?.[key];
  if (state === "unavailable") return UNMEASURED;
  if (state === "uncalibrated") return `${esc(value)}${unit} (sem calibração: pixels, não metros)`;
  return `${esc(value)}${unit}`;
}

function sportMetricSummary(analysis: VisionAnalysisRecord): string | null {
  const metrics = analysis.sportMetrics?.metrics;
  if (!metrics?.length) return null;
  return `MÉTRICAS ESPORTIVAS (${analysis.sportMetrics?.contractVersion}):\n${metrics.map((metric) => `- ${metric.label}: ${metric.status === "measured" ? `${esc(metric.value)} ${metric.unit}` : `indisponível (${metric.status}: ${esc(metric.unavailableReason)})`}`).join("\n")}`;
}

function visionHeader(analysis: VisionAnalysisRecord, title: string): string {
  const meta = analysis.metadata ?? {};
  const lines = [
    `VÍDEO: ${esc(title)} · ${esc(meta.durationSeconds ?? 0)} s · ${esc(meta.width)}×${esc(meta.height)} a ${esc(meta.fps)} fps`,
    `MOTOR: ${esc(analysis.engine)} ${esc(analysis.engineVersion)} · amostragem ${esc(meta.sampleFps)} Hz · ${meta.calibrated ? "calibrado em metros" : `sem calibração (unidades: ${esc(meta.units ?? "px")} - velocidades e distâncias NÃO são metros)`}`,
  ];
  if (typeof meta.keyframesTruncatedAt === "number") {
    lines.push(`ATENÇÃO: a pose sincronizada cobre só até ${esc(meta.keyframesTruncatedAt)} s; depois disso não há evidência quadro a quadro.`);
  }
  if (analysis.engine === "AquaMotion") {
    lines.push("LIMITE DO MOTOR: AquaMotion mede apenas movimento global da cena. Não há atletas identificados, braçadas, velocidade ou fases - não afirme nada disso.");
  }
  return lines.join("\n");
}

/** Contexto completo do vídeo: métricas por atleta, timeline de braçadas e perfil de movimento. */
export function buildVisionCoachContext(analysis: VisionAnalysisRecord, title: string): string {
  const meta = analysis.metadata ?? {};
  const metrics = analysis.metrics ?? {};
  const sections = [visionHeader(analysis, title)];
  const sportSummary = sportMetricSummary(analysis);
  if (sportSummary) sections.push(sportSummary);
  const sportsGated = Boolean(analysis.sportMetrics?.metrics.some((metric) => metric.status !== "measured"));
  const people = analysis.people ?? [];
  if (people.length) {
    const primary = meta.primaryPersonId ?? people[0]?.id;
    sections.push(sportsGated
      ? `MÉTRICAS DO ATLETA PRINCIPAL (#${esc(primary)}): indisponíveis até a validação dos extratores esportivos.`
      : `MÉTRICAS DO ATLETA PRINCIPAL (#${esc(primary)}): ${esc(metrics.detectedCycles ?? 0)} braçadas · cadência ${metrics.estimatedCadence ? `${esc(metrics.estimatedCadence)}/min` : UNMEASURED} · consistência rítmica ${metrics.estimatedCadence ? `${esc(metrics.rhythmConsistency ?? 0)}%` : UNMEASURED}`);
    sections.push(`ATLETAS RASTREADOS (${people.length}):\n${people.slice(0, 6).map((person) => {
      const strokeTimes = (person.strokeTimes ?? []).slice(0, 60);
      const extra = (person.strokeTimes ?? []).length > 60 ? " …" : "";
      const units = person.units ?? meta.units ?? "px";
      const gaps = person.gaps ?? [];
      return [
        `- Atleta #${person.id}: presente de ${esc(person.firstSeen)} s a ${esc(person.lastSeen)} s (${esc(person.durationSeconds)} s rastreados)${gaps.length ? ` · ${gaps.length} lacuna(s) sem rastreio: ${gaps.slice(0, 8).map((gap) => `${esc(gap.from)}-${esc(gap.to)}s`).join(", ")}` : ""}`,
        sportsGated ? "  métricas esportivas indisponíveis: os extratores ainda não foram validados." : `  braçadas ${measured(person, "strokes", person.strokes)} · cadência ${measured(person, "strokeRate", person.strokeRate, "/min")} · consistência ${measured(person, "rhythmConsistency", person.rhythmConsistency, "%")} · distância por braçada ${measured(person, "distancePerStroke", person.distancePerStroke, ` ${units}`)}`,
        sportsGated ? "" : `  velocidade média ${measured(person, "avgSpeed", person.avgSpeed, ` ${units}/s`)} · pico ${measured(person, "maxSpeed", person.maxSpeed, ` ${units}/s`)} · distância ${measured(person, "distance", person.distance, ` ${units}`)}`,
        `  confiança média ${esc(Math.round(person.meanConfidence * 100))}% · cobertura de pose ${esc(person.coverage)}%${person.strokeSignal ? ` · sinal de braçada: ${esc(person.strokeSignal)}` : ""}`,
        !sportsGated && (strokeTimes.length ? `  braçadas em: ${strokeTimes.map((time) => `${esc(time)}s`).join(", ")}${extra}` : "  sem ciclos completos detectados (janela rastreável curta ou atleta submerso)"),
      ].filter(Boolean).join("\n");
    }).join("\n")}`);
  } else {
    sections.push("ATLETAS RASTREADOS: nenhum - o rastreamento não encontrou atletas com evidência suficiente neste vídeo.");
  }
  const timeline = analysis.timeline ?? [];
  if (timeline.length) {
    const buckets = Math.min(12, Math.max(4, Math.round(timeline.length / 8)));
    const size = Math.max(1, Math.ceil(timeline.length / buckets));
    const profile: string[] = [];
    for (let index = 0; index < timeline.length; index += size) {
      const chunk = timeline.slice(index, index + size);
      profile.push(`${chunk[0].time.toFixed(1)}-${chunk[chunk.length - 1].time.toFixed(1)}s: movimento médio ${Math.round(chunk.reduce((sum, item) => sum + item.motion, 0) / chunk.length)}/100`);
    }
    sections.push(`PERFIL DE MOVIMENTO AO LONGO DO VÍDEO:\n${profile.join("\n")}`);
  }
  const strokes = sportsGated ? [] : (analysis.events ?? []).filter((event) => event.category === "stroke");
  if (strokes.length) {
    sections.push(`EVENTOS DE BRAÇADA (${strokes.length}): ${strokes.slice(0, 40).map((event) => `${event.time.toFixed(1)}s${typeof event.personId === "number" ? ` (#${event.personId})` : ""}`).join(", ")}${strokes.length > 40 ? " …" : ""}`);
  }
  return sections.join("\n\n");
}

/** Contexto da janela ao vivo: quem está no quadro agora, o que acabou de acontecer. */
export function buildLiveWindowContext(analysis: VisionAnalysisRecord, currentTime: number, windowSeconds = 4): string {
  const meta = analysis.metadata ?? {};
  const from = Math.max(0, currentTime - windowSeconds);
  // A janela termina no instante atual: comentar o que ainda não aconteceu
  // no player deixava o comentário fora de sincronia com o vídeo.
  const to = currentTime;
  const frames = (analysis.keyframes ?? []).filter((frame) => frame.t >= from && frame.t <= to);
  const presence = new Map<number, { frames: number; lastSeen: number; confidence: number; x0: number; x1: number; y0: number; y1: number }>();
  for (const frame of frames) {
    for (const person of frame.persons) {
      const nose = person.kpts?.[0];
      if (!nose || nose.length < 3) continue;
      const entry = presence.get(person.id) ?? { frames: 0, lastSeen: frame.t, confidence: 0, x0: nose[0], x1: nose[0], y0: nose[1], y1: nose[1] };
      entry.frames += 1;
      entry.lastSeen = Math.max(entry.lastSeen, frame.t);
      entry.confidence += nose[2];
      entry.x0 = entry.frames === 1 ? nose[0] : entry.x0;
      entry.y0 = entry.frames === 1 ? nose[1] : entry.y0;
      entry.x1 = nose[0];
      entry.y1 = nose[1];
      presence.set(person.id, entry);
    }
  }
  const sections = [visionHeader(analysis, "treino"), `INSTANTE ATUAL: t = ${currentTime.toFixed(1)} s (janela de análise: ${from.toFixed(1)} s a ${to.toFixed(1)} s)`];
  if (typeof meta.keyframesTruncatedAt === "number" && from > meta.keyframesTruncatedAt) {
    sections.push("ATLETAS NO QUADRO AGORA: sem evidência - a pose sincronizada não cobre este trecho do vídeo.");
  } else if (presence.size) {
    const lines = [...presence.entries()].map(([id, entry]) => {
      const span = Math.max(0.1, entry.lastSeen - from);
      const speed = Math.hypot(entry.x1 - entry.x0, entry.y1 - entry.y0) / span;
      return `- Atleta #${id}: no quadro em ${entry.frames} amostras · confiança média do nariz ${Math.round((entry.confidence / entry.frames) * 100)}% · deslocamento estimado ${speed.toFixed(1)} px/s (medido em pixels da imagem, não em metros)`;
    });
    sections.push(`ATLETAS NO QUADRO AGORA:\n${lines.join("\n")}`);
  } else {
    sections.push("ATLETAS NO QUADRO AGORA: nenhum com pose confiável nesta janela (atleta possivelmente submerso ou fora do quadro).");
  }
  const strokes = (analysis.events ?? []).filter((event) => event.category === "stroke" && event.time >= from && event.time <= to);
  sections.push(strokes.length
    ? `BRAÇADAS NESTA JANELA: ${strokes.map((event) => `${event.time.toFixed(1)}s${typeof event.personId === "number" ? ` (#${event.personId})` : ""}`).join(", ")}`
    : "BRAÇADAS NESTA JANELA: nenhuma detectada.");
  const timeline = analysis.timeline ?? [];
  const near = timeline.filter((item) => item.time >= from && item.time <= to);
  if (near.length) {
    sections.push(`MOVIMENTO NA JANELA: média ${Math.round(near.reduce((sum, item) => sum + item.motion, 0) / near.length)}/100`);
  }
  const people = analysis.people ?? [];
  if (people.length) {
    sections.push(`MÉTRICAS GLOBAIS POR ATLETA (vídeo inteiro):\n${people.slice(0, 6).map((person) => `- Atleta #${person.id}: ${measured(person, "strokes", person.strokes)} braçadas · cadência ${measured(person, "strokeRate", person.strokeRate, "/min")} · velocidade média ${measured(person, "avgSpeed", person.avgSpeed, ` ${person.units ?? meta.units ?? "px"}/s`)}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

async function callLLm(messages: Array<{ role: string; content: string }>): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, messages, max_tokens: 1600, temperature: 0.4, stream: false }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      let detail = "erro sem detalhes";
      try {
        const payload = JSON.parse(raw) as { error?: { message?: string } };
        detail = payload.error?.message?.trim() || detail;
      } catch { /* resposta não JSON: mantém erro sanitizado */ }
      throw new Error(`LLM respondeu ${response.status}: ${detail.slice(0, 240)}`);
    }
    // Alguns gateways ignoram stream:false e devolvem SSE — tratar ambos os formatos.
    const contentType = response.headers.get("content-type") ?? "";
    if (raw.startsWith("data:") || contentType.includes("text/event-stream")) {
      const chunks = raw.split("\n").filter((line) => line.startsWith("data:") && !line.includes("[DONE]"));
      let assembled = "";
      let reasoning = "";
      for (const chunk of chunks) {
        try {
          const parsed = JSON.parse(chunk.slice(5).trim()) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; message?: { content?: string } }> };
          assembled += parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
          reasoning += parsed.choices?.[0]?.delta?.reasoning_content ?? "";
        } catch { /* linha keep-alive ignorada */ }
      }
      if (assembled.trim()) return assembled;
      if (reasoning.trim()) return reasoning;
      throw new Error("Stream sem conteúdo");
    }
    const payload = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
    const message = payload.choices?.[0]?.message;
    // Modelos com raciocínio podem devolver content vazio e a resposta em
    // reasoning_content; usar o fallback antes de declarar falha.
    const content = message?.content?.trim() || message?.reasoning_content?.trim();
    if (!content) throw new Error("Resposta vazia do modelo");
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

async function inspectLlmAvailability() {
  if (!LLM_API_KEY) return { available: false, reason: "LLM_API_KEY não configurada" };
  if (statusCache && Date.now() - statusCache.checkedAt < 60_000) return statusCache;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${LLM_BASE_URL}/models`, { headers: { authorization: `Bearer ${LLM_API_KEY}` }, signal: controller.signal });
    if (!response.ok) {
      statusCache = { checkedAt: Date.now(), available: false, reason: `Gateway respondeu ${response.status}` };
      return statusCache;
    }
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const available = Boolean(payload.data?.some((model) => model.id === LLM_MODEL));
    statusCache = { checkedAt: Date.now(), available, reason: available ? undefined : `Modelo ${LLM_MODEL} não está liberado para esta chave` };
    return statusCache;
  } catch (error) {
    statusCache = { checkedAt: Date.now(), available: false, reason: error instanceof Error && error.name === "AbortError" ? "Gateway não respondeu em 10s" : "Falha ao consultar o gateway" };
    return statusCache;
  } finally {
    clearTimeout(timeout);
  }
}

export function registerAiRoutes(app: FastifyInstance, store: ManagedStore) {
  app.get("/api/v1/ai/status", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação exclusiva da comissão técnica" : "Autenticação necessária" });
    const health = await inspectLlmAvailability();
    return { available: health.available, reason: health.reason, model: LLM_API_KEY ? LLM_MODEL : null, gateway: LLM_API_KEY ? LLM_BASE_URL : null };
  });

  app.post("/api/v1/ai/chat", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação exclusiva da comissão técnica" : "Autenticação necessária" });
    const body = (await request.body) as { messages?: ChatMessage[] } | null;
    const history = Array.isArray(body?.messages) ? body!.messages!.slice(-12) : [];
    if (!history.length || history.some((m) => typeof m.content !== "string" || !m.content.trim())) {
      return reply.code(400).send({ error: "Envie ao menos uma mensagem válida." });
    }
    if (!LLM_API_KEY) {
      return reply.code(503).send({ error: "Assistente indisponível: configure LLM_API_KEY no ambiente da API." });
    }

    const context = `${buildPlatformContext(store, user!.organizationId)}\n\n${user!.organizationId === "org-demo" ? buildPerformanceContext() : ""}`;
    const messages = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n=== SNAPSHOT DA PLATAFORMA ===\n${context}` },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    try {
      const answer = await callLLm(messages);
      return { reply: answer, model: LLM_MODEL, at: new Date().toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao consultar o modelo";
      return reply.code(502).send({ error: `Não consegui responder agora: ${message}` });
    }
  });

  /** Relatório técnico completo do vídeo, com a persona de treinador de seleção. */
  app.post("/api/v1/ai/vision-coach/report", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação exclusiva da comissão técnica" : "Autenticação necessária" });
    const body = (await request.body) as { videoId?: string } | null;
    const videoId = typeof body?.videoId === "string" ? body.videoId.trim() : "";
    if (!videoId) return reply.code(400).send({ error: "Informe o vídeo a analisar." });
    const record = store.get("videos", videoId);
    if (!record || record.organizationId !== user!.organizationId) return reply.code(404).send({ error: "Vídeo não encontrado" });
    const analysis = record.analysis as VisionAnalysisRecord | undefined;
    if (!analysis?.engine) return reply.code(422).send({ error: "Este vídeo ainda não tem análise de visão concluída." });
    if (!LLM_API_KEY) return reply.code(503).send({ error: "Assistente indisponível: configure LLM_API_KEY no ambiente da API." });
    const context = buildVisionCoachContext(analysis, String(record.title ?? record.name ?? "Vídeo de treino"));
    const messages = [
      { role: "system", content: `${VISION_COACH_PROMPT}\n\nMODO RELATÓRIO: você recebe os dados do vídeo INTEIRO. Produza o relatório técnico completo: (1) o que acontece no vídeo do início ao fim, (2) análise por atleta com os números, (3) riscos técnicos que os indicadores sugerem, (4) três prescrições concretas e priorizadas para o próximo treino. Use os tempos em segundos e marque claramente onde a evidência é fraca.` },
      { role: "user", content: context },
    ];
    try {
      const answer = await callLLm(messages);
      return { reply: answer, model: LLM_MODEL, at: new Date().toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao consultar o modelo";
      return reply.code(502).send({ error: `Não consegui gerar o relatório: ${message}` });
    }
  });

  /** Observação ao vivo: contexto da janela atual do player, sincronizado com a reprodução. */
  app.post("/api/v1/ai/vision-coach/live", async (request, reply) => {
    const user = await getSession(sessionToken(request));
    if (!roleAllows(user, ["coach", "admin"])) return reply.code(user ? 403 : 401).send({ error: user ? "Ação exclusiva da comissão técnica" : "Autenticação necessária" });
    const body = (await request.body) as { videoId?: string; currentTime?: number; windowSeconds?: number } | null;
    const videoId = typeof body?.videoId === "string" ? body.videoId.trim() : "";
    const currentTime = Number(body?.currentTime);
    const windowSeconds = Number(body?.windowSeconds);
    if (!videoId) return reply.code(400).send({ error: "Informe o vídeo a analisar." });
    if (!Number.isFinite(currentTime) || currentTime < 0) return reply.code(400).send({ error: "Instante atual inválido." });
    if (!Number.isFinite(windowSeconds) || windowSeconds < 1 || windowSeconds > 10) return reply.code(400).send({ error: "Janela de análise inválida (1 a 10 s)." });
    const record = store.get("videos", videoId);
    if (!record || record.organizationId !== user!.organizationId) return reply.code(404).send({ error: "Vídeo não encontrado" });
    const analysis = record.analysis as VisionAnalysisRecord | undefined;
    if (!analysis?.engine) return reply.code(422).send({ error: "Este vídeo ainda não tem análise de visão concluída." });
    if (!LLM_API_KEY) return reply.code(503).send({ error: "Assistente indisponível: configure LLM_API_KEY no ambiente da API." });
    const context = buildLiveWindowContext(analysis, currentTime, windowSeconds);
    const messages = [
      { role: "system", content: `${VISION_COACH_PROMPT}\n\nMODO AO VIVO: você está acompanhando o vídeo em tempo real junto com o treinador. Comente em 2 a 4 frases objetivas o que está acontecendo NESTE instante e dê UMA correção acionável. Sem introduções, sem repetir o contexto.` },
      { role: "user", content: context },
    ];
    try {
      const answer = await callLLm(messages);
      return { reply: answer, model: LLM_MODEL, at: new Date().toISOString(), currentTime };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao consultar o modelo";
      return reply.code(502).send({ error: `Não consegui comentar agora: ${message}` });
    }
  });
}
