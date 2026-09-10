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

  for (const [kind, label, fields] of [
    ["racePlans", "Planos de prova", ["title", "athleteId", "description", "cycles"]],
    ["protocols", "Protocolos", ["title", "category", "description"]],
    ["staffAssessments", "Percepção da comissão", ["athleteId", "date", "assessment", "note"]],
    ["readinessScores", "Prontidão registrada", ["athleteId", "date", "score", "readiness", "source"]],
    ["loadSnapshots", "Carga registrada", ["athleteId", "date", "value", "atl", "ctl", "tss", "engine", "source"]],
  ] as const) {
    const records = list(kind).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,50);
    if (records.length) sections.push(`## ${label} (até 50 registros recentes)\n${records.map(r => fields.map(field => `${field}: ${esc(r[field])}`).join(" · ")).join("\n")}`);
  }
  return sections.join("\n\n");
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
  keyframeSegments?: Array<{ from: number; to: number; count: number; keyframes: Array<{ t: number; persons: Array<{ id: number; kpts: number[][] }> }> }>;
};

const UNMEASURED = "não medido";

function keyframesForAnalysis(analysis: VisionAnalysisRecord) {
  if (analysis.keyframeSegments) return analysis.keyframeSegments.flatMap((segment) => segment.keyframes);
  return analysis.keyframes ?? [];
}

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
  const frames = keyframesForAnalysis(analysis).filter((frame) => frame.t >= from && frame.t <= to);
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
    const body = (await request.body) as { messages?: ChatMessage[]; language?: string } | null;
    const history = Array.isArray(body?.messages) ? body!.messages!.slice(-12) : [];
    if (!history.length || history.some((m) => !["user", "assistant"].includes(m.role) || typeof m.content !== "string" || !m.content.trim() || m.content.length > 16000)) {
      return reply.code(400).send({ error: "Envie ao menos uma mensagem válida." });
    }
    if (!LLM_API_KEY) {
      return reply.code(503).send({ error: "Assistente indisponível: configure LLM_API_KEY no ambiente da API." });
    }

    const context = buildPlatformContext(store, user!.organizationId);
    const language = ({ "pt-BR": "português do Brasil", en: "English", es: "español", fr: "français" } as Record<string, string>)[body?.language ?? "pt-BR"] ?? "português do Brasil";
    const messages = [
      { role: "system", content: `${SYSTEM_PROMPT}\nIdioma escolhido pelo técnico: ${language}. Responda nesse idioma.\n\n=== SNAPSHOT DA PLATAFORMA ===\n${context}` },
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
