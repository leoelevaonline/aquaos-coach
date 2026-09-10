"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Send, X, MessageCircle } from "lucide-react";
import { API_URL, apiRequest } from "./api";

type ChatMessage = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "Como está a prontidão da equipe hoje?",
  "Qual atleta está mais perto da meta?",
  "Resuma a semana de treinos",
  "Quem preciso monitorar de perto?",
  "Como está a fila de vídeos?",
  "Como está o volume da equipe?",
];

/** Estágios exibidos enquanto o assistente processa — dão noção de progresso. */
const THINKING_STAGES = [
  "Consultando os dados da plataforma…",
  "Analisando atletas, treinos e metas…",
  "Cruzando prontidão, volume e carga…",
  "Redigindo a resposta…",
];

/** Sanitiza a resposta do modelo: remove cabeçalhos ##, artefatos de markdown residual e espaços duplos. */
function sanitizeLine(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*([^*]+)\*\*/g, "**$1**")
    .replace(/[*_]{2,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function renderContent(content: string) {
  // Markdown leve higienizado: **negrito**, listas "- "/"• ", quebras de linha.
  const blocks = content
    .split("\n")
    .map((line) => sanitizeLine(line))
    .filter((line) => line.length > 0);
  const elements: React.ReactNode[] = [];
  let bulletGroup: React.ReactNode[] = [];

  const flushBullets = (key: string) => {
    if (bulletGroup.length) {
      elements.push(<ul key={`ul-${key}`} className="chat-bullet-group">{bulletGroup}</ul>);
      bulletGroup = [];
    }
  };

  blocks.forEach((line, index) => {
    const isBullet = /^[-•*]\s+/.test(line);
    const text = line.replace(/^[-•*]\s+/, "");
    const parts = text.split(/(\*\*[^*]+\*\*)/g).map((part, partIndex) =>
      part.startsWith("**") && part.endsWith("**")
        ? <strong key={partIndex}>{part.slice(2, -2)}</strong>
        : <span key={partIndex}>{part}</span>
    );
    if (isBullet) {
      bulletGroup.push(<li key={index} className="chat-bullet">{parts}</li>);
    } else {
      flushBullets(String(index));
      elements.push(<p key={index}>{parts}</p>);
    }
  });
  flushBullets("end");
  return elements;
}

function ThinkingIndicator() {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setStage((current) => Math.min(current + 1, THINKING_STAGES.length - 1));
    }, 2600);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="ai-msg-content ai-thinking">
      <div className="ai-thinking-stage">
        <span className="ai-typing"><i /><i /><i /></span>
        <span className="ai-thinking-label">{THINKING_STAGES[stage]}</span>
      </div>
      <div className="ai-thinking-progress">
        {THINKING_STAGES.map((label, index) => (
          <i key={label} className={index <= stage ? "done" : ""} />
        ))}
      </div>
    </div>
  );
}

export function AiAssistant({ embedded = false }: { embedded?: boolean }) {
  const [open, setOpen] = useState(embedded);
  const [language, setLanguage] = useState("pt-BR");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (available !== null || !open) return;
    apiRequest<{ available: boolean }>("/api/v1/ai/status")
      .then((status) => setAvailable(status.available))
      .catch(() => setAvailable(false));
  }, [open, available]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    try {
      const response = await apiRequest<{ reply: string }>("/api/v1/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, language }),
      });
      setMessages((current) => [...current, { role: "assistant", content: response.reply }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao consultar o assistente";
      setMessages((current) => [...current, { role: "assistant", content: `**Erro:** ${message}` }]);
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button className="ai-fab" onClick={() => setOpen(true)} aria-label="Abrir assistente de IA">
        <MessageCircle size={21} />
      </button>
    );
  }

  return (
    <>
      <div className={`ai-panel ${embedded ? "ai-embedded" : ""}`} role={embedded ? "region" : "dialog"} aria-label="RKF IA">
        <header className="ai-panel-head">
          <div className="ai-panel-title">
            <span className="ai-panel-badge"><Bot size={17} /></span>
            <div>
              <strong>RKF IA</strong>
              <small>{available === false ? "offline" : "conectado aos dados da plataforma"}</small>
            </div>
          </div>
          <label className="coach-field">Idioma da resposta<select value={language} onChange={e => setLanguage(e.target.value)}><option value="pt-BR">Português</option><option value="en">English</option><option value="es">Español</option><option value="fr">Français</option></select></label>{!embedded && <button className="ai-panel-close" onClick={() => setOpen(false)} aria-label="Fechar assistente"><X size={18} /></button>}
        </header>

        <div className="ai-panel-body" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="ai-welcome">
              <span className="ai-welcome-icon"><MessageCircle size={22} /></span>
              <strong>Pergunte qualquer coisa da plataforma</strong>
              <p>Atletas, treinos, metas, competições, vídeos, prontidão, volumes e auditoria. As respostas usam os registros disponíveis no momento da consulta.</p>
              <div className="ai-suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} onClick={() => void send(suggestion)}>{suggestion}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message, index) => (
            <div key={index} className={`ai-msg ${message.role}`}>
              {message.role === "assistant" && <span className="ai-msg-avatar"><Bot size={14} /></span>}
              <div className="ai-msg-content">{renderContent(message.content)}</div>
            </div>
          ))}
          {loading && (
            <div className="ai-msg assistant">
              <span className="ai-msg-avatar"><Bot size={14} /></span>
              <ThinkingIndicator />
            </div>
          )}
        </div>

        <form
          className="ai-panel-input"
          onSubmit={(event) => { event.preventDefault(); void send(); }}
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={available === false ? "Assistente indisponível. Tente novamente mais tarde." : "Pergunte sobre atletas, treinos, metas…"}
            aria-label="Mensagem para o assistente"
            disabled={available === false}
          />
          <button type="submit" disabled={!input.trim() || loading} aria-label="Enviar mensagem"><Send size={16} /></button>
        </form>
      </div>
    </>
  );
}
