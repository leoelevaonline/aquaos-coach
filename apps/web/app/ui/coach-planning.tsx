"use client";
import { useState } from 'react';
import { apiRequest } from './api';
import { ModalShell, PageTitle, SectionHead } from './components';
import { dateKey, formatSwimTime, parseSwimTime, useCoachRecords, type CoachRecord } from './coach-data';
import { renderContent } from './ai-assistant';
import type { WorkoutSeed } from './workout-library-actions';

async function ask(content: string) {
  const result = await apiRequest<{ reply: string }>('/api/v1/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'pt-BR', messages: [{ role: 'user', content }] }) });
  return result.reply;
}

export function WorkoutEntry({ seed, onClose, onChoose }: { seed?: WorkoutSeed; onClose: () => void; onChoose: (seed?: WorkoutSeed) => void }) {
  const [mode, setMode] = useState('Coach escreve');
  const [query, setQuery] = useState('');
  const [output, setOutput] = useState('Treino');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { data, loading, error: listError } = useCoachRecords(['workouts', 'protocols', 'trainingSessions', 'sessionBlocks']);
  const examples = mode === 'Pesquisar séries' ? [...(data.protocols ?? []).filter(r => r.category === 'Séries'), ...(data.sessionBlocks ?? [])] : [...(data.workouts ?? []), ...(data.trainingSessions ?? [])];
  const found = examples.filter(r => JSON.stringify(r).toLowerCase().includes(query.toLowerCase())).slice(0, 40);
  async function generate() { setBusy(true); setError(''); try { setAnswer(await ask(`Crie ${output === 'Treino' ? 'um rascunho de treino' : 'ideias de treino'} de natação para revisão da comissão. Não publique nada. Solicitação: ${query}`)); } catch(e) { setError(String(e)); } finally { setBusy(false); } }
  const useText = (text: string, title = seed?.title ?? 'Novo treino') => onChoose({ zone: "A1", kind: "swim", ...seed, title, prompt: text, distanceMeters: seed?.distanceMeters ?? 0 });
  return <ModalShell title="Criar treino" subtitle="Escolha como preparar a sessão" onClose={onClose} wide><div className="coach-panel">
    <div className="tab-bar">{['RKF IA escreve', 'Coach escreve', 'Pesquisar exemplos', 'Pesquisar séries'].map(m => <button key={m} className={m === mode ? 'active' : ''} onClick={() => setMode(m)}>{m}</button>)}</div>
    {mode === 'Coach escreve' ? <><p>Escreva, dite ou importe o conteúdo e revise antes de publicar.</p><button className="primary-button" onClick={() => onChoose(seed)}>Abrir editor de treino</button></> : <><label className="coach-field">{mode === 'RKF IA escreve' ? 'Objetivo, volume, zona, nível e restrições' : 'Pesquisar no acervo da plataforma'}<textarea value={query} onChange={e => setQuery(e.target.value)} /></label>
    {mode === 'RKF IA escreve' ? <><label className="coach-field">Resultado<select value={output} onChange={e => setOutput(e.target.value)}><option>Treino</option><option>Ideias</option></select></label><button className="primary-button" disabled={busy || query.trim().length < 5} onClick={() => void generate()}>{busy ? 'Preparando…' : `Gerar ${output.toLowerCase()}`}</button>{answer && <div className="coach-answer">{renderContent(answer)}<button className="secondary-button" onClick={() => useText(answer)}>Levar ao editor para revisar</button></div>}</> : <>{loading && <p>Carregando acervo…</p>}{found.map(r => <article className="cycle-row" key={r.id}><h3>{String(r.title ?? r.name ?? r.id)}</h3><p>{String(r.prescriptionText ?? r.description ?? r.notes ?? '')}</p><button className="secondary-button" onClick={() => useText(String(r.prescriptionText ?? r.description ?? r.notes ?? JSON.stringify(r)), String(r.title ?? r.name ?? 'Treino adaptado'))}>Usar como ponto de partida</button></article>)}{!loading && !found.length && <p>Nenhum resultado no acervo.</p>}</>}
    </>}{(error || listError) && <p role="alert">{error || listError}</p>}
  </div></ModalShell>;
}

export function Protocols({ onUse }: { onUse: (seed?: WorkoutSeed) => void }) {
  return <Notebook kind="protocols" title="Protocolos" onUse={onUse} />;
}
export function PerfectRace() { return <><Notebook kind="racePlans" title="Prova Perfeita" /><TimeConverter /></>; }

function Notebook({ kind, title, onUse }: { kind: 'protocols' | 'racePlans'; title: string; onUse?: (seed?: WorkoutSeed) => void }) {
  const { data, error, loading, reload } = useCoachRecords([kind, 'athletes']);
  const [editing, setEditing] = useState<CoachRecord | null>(null);
  const [name, setName] = useState(''); const [body, setBody] = useState(''); const [category, setCategory] = useState('Séries');
  const [athleteId, setAthleteId] = useState(''); const [cycles, setCycles] = useState('');
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState('Todos');
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [deleting, setDeleting] = useState('');
  const [suggestion, setSuggestion] = useState('');
  function edit(row: CoachRecord = { id: '' }) { setEditing(row); setName(String(row.title ?? '')); setBody(String(row.description ?? '')); setCategory(String(row.category ?? 'Séries')); setAthleteId(String(row.athleteId ?? '')); setCycles(row.cycles == null ? '' : String(row.cycles)); setSuggestion(''); setMessage(''); }
  async function save() { setBusy(true); setMessage(''); try {
    await apiRequest(`/api/v1/manage/${kind}${editing?.id ? `/${editing.id}` : ''}`, { method: editing?.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: name.trim(), description: body.trim(), category: kind === 'protocols' ? category : 'Estratégia de prova', athleteId: athleteId || undefined, cycles: cycles === '' ? null : Number(cycles), status: 'draft', date: dateKey(), source: 'Comissão técnica' }) });
    setEditing(null); reload(); setMessage('Registro salvo.');
  } catch(e) { setMessage(String(e)); } finally { setBusy(false); } }
  async function remove() { setBusy(true); try { await apiRequest(`/api/v1/manage/${kind}/${deleting}`, { method: 'DELETE' }); setDeleting(''); reload(); } catch(e) { setMessage(String(e)); } finally { setBusy(false); } }
  async function suggest() { setBusy(true); setMessage(''); try { setSuggestion(await ask(`Sugira estratégias de prova de natação para revisão humana. Não invente dados ausentes. Prova: ${name}. Anotações: ${body}. Ciclos planejados informados: ${cycles || 'não informado'}.`)); } catch(e) { setMessage(String(e)); } finally { setBusy(false); } }
  const rows = (data[kind] ?? []).filter(r => (filter === 'Todos' || r.category === filter) && `${r.title} ${r.description}`.toLowerCase().includes(query.toLowerCase()));
  return <><PageTitle kicker="COMISSÃO TÉCNICA" title={title} subtitle={kind === 'protocols' ? 'Séries, testes e protocolos para consultar, adaptar e aplicar.' : 'Estratégia, ciclos de braçada e sugestões de IA revisadas pelo treinador.'}><button className="primary-button" onClick={() => edit()}>Novo {kind === 'protocols' ? 'protocolo' : 'plano de prova'}</button></PageTitle>
    <section className="card coach-panel"><div className="coach-toolbar"><label className="coach-field">Buscar<input value={query} onChange={e => setQuery(e.target.value)} /></label>{kind === 'protocols' && <label className="coach-field">Categoria<select value={filter} onChange={e => setFilter(e.target.value)}>{['Todos', 'Séries', 'Testes', 'Outros protocolos'].map(c => <option key={c}>{c}</option>)}</select></label>}</div>{loading && <p>Carregando…</p>}{error && <p role="alert">{error}</p>}{rows.map(r => <article className="cycle-row" key={r.id}><h3>{String(r.title)}</h3><small>{String(r.category ?? '')} · {String(data.athletes?.find(a => a.id === r.athleteId)?.name ?? 'Programa')} {r.cycles != null ? `· ${r.cycles} ciclos planejados` : ''}</small><p className="preserve-lines">{String(r.description ?? '')}</p><div className="coach-toolbar"><button className="secondary-button" onClick={() => edit(r)}>Editar</button><button className="secondary-button" onClick={() => setDeleting(r.id)}>Excluir</button>{onUse && <button className="primary-button" onClick={() => onUse({ title: String(r.title), prompt: String(r.description ?? ''), distanceMeters: 0, zone: "A1", kind: "swim" })}>Usar no treino</button>}</div></article>)}{!loading && !rows.length && <p>Nenhum registro nesta seleção. Crie o primeiro para construir o acervo da comissão.</p>}{message && !editing && <p role="status">{message}</p>}</section>
    {editing && <ModalShell title={editing.id ? 'Editar registro' : 'Novo registro'} subtitle={title} onClose={() => setEditing(null)}><form className="coach-form coach-panel" onSubmit={e => { e.preventDefault(); void save(); }}><label>Título<input required minLength={3} value={name} onChange={e => setName(e.target.value)} /></label>{kind === 'protocols' && <label>Categoria<select value={category} onChange={e => setCategory(e.target.value)}><option>Séries</option><option>Testes</option><option>Outros protocolos</option></select></label>}<label>Atleta<select value={athleteId} onChange={e => setAthleteId(e.target.value)}><option value="">Programa / sem atleta específico</option>{(data.athletes ?? []).map(a => <option key={a.id} value={a.id}>{String(a.name)}</option>)}</select></label>{kind === 'racePlans' && <label>Ciclos de braçada planejados<input type="number" min={0} step={1} value={cycles} onChange={e => setCycles(e.target.value)} /></label>}<label>{kind === 'protocols' ? 'Série, execução, critérios e observações' : 'Estratégia, parciais, saída, viradas e chegada'}<textarea required minLength={3} rows={8} value={body} onChange={e => setBody(e.target.value)} /></label>{kind === 'racePlans' && <button type="button" className="secondary-button" disabled={busy || !name.trim()} onClick={() => void suggest()}>Solicitar sugestões da IA</button>}{suggestion && <div className="coach-answer">{renderContent(suggestion)}<button type="button" className="secondary-button" onClick={() => { setBody(b => `${b}\n\nSugestões para revisão:\n${suggestion}`); setSuggestion(''); }}>Incorporar ao rascunho</button></div>}{message && <p role="alert">{message}</p>}<button className="primary-button" disabled={busy}>{busy ? 'Processando…' : 'Salvar rascunho'}</button></form></ModalShell>}
    {deleting && <ModalShell title="Excluir registro?" subtitle="Esta ação remove o registro do acervo e mantém o evento de auditoria." onClose={() => setDeleting('')}><div className="coach-panel"><button className="secondary-button" onClick={() => setDeleting('')}>Cancelar</button><button className="primary-button" disabled={busy} onClick={() => void remove()}>Confirmar exclusão</button>{message && <p role="alert">{message}</p>}</div></ModalShell>}
  </>;
}

export function TimeConverter() {
  const [time, setTime] = useState(''); const [distance, setDistance] = useState(200); const [target, setTarget] = useState(100); const [adjustment, setAdjustment] = useState('0');
  const seconds = parseSwimTime(time); const valid = seconds !== null && distance > 0 && target > 0 && Number.isFinite(Number(adjustment)) && seconds * target / distance + Number(adjustment) > 0;
  return <section className="card coach-panel"><SectionHead title="Conversor de tempos" subtitle="Ritmo proporcional e ajuste informado pela comissão" /><div className="coach-toolbar"><label className="coach-field">Tempo (m:ss.cc)<input value={time} onChange={e => setTime(e.target.value)} placeholder="1:58.50" /></label><label className="coach-field">Distância de origem (m)<input type="number" min={1} value={distance} onChange={e => setDistance(Number(e.target.value))} /></label><label className="coach-field">Distância de destino (m)<input type="number" min={1} value={target} onChange={e => setTarget(Number(e.target.value))} /></label><label className="coach-field">Ajuste técnico (s)<input type="number" step="0.01" value={adjustment} onChange={e => setAdjustment(e.target.value)} /></label></div><output aria-live="polite">{valid ? formatSwimTime(seconds! * target / distance + Number(adjustment)) : 'Informe um tempo e distâncias válidos.'}</output><p className="coach-explanation">Cálculo: tempo × distância de destino ÷ distância de origem + ajuste. Não é previsão de performance nem conversão oficial 25 m ↔ 50 m. Para essa conversão, a comissão deve fornecer o ajuste ou a tabela homologada.</p></section>;
}
