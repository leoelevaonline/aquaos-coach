"use client";
import { useEffect, useState } from 'react';
import { apiRequest } from './api';
import { useCoachRecords, dateKey, latest, metric, recordDate, athleteLoad, type CoachRecord } from './coach-data';
import { ModalShell, PageTitle, SectionHead } from './components';

function State({ error, loading }: { error: string; loading: boolean }) { return error ? <p role="alert">{error}</p> : loading ? <p role="status">Atualizando registros…</p> : null; }
function Evidence({ row, children }: { row?: CoachRecord; children: React.ReactNode }) {
  return <span>{row ? children : 'Sem dados'}{row && <small>{recordDate(row)} · {String(row.source ?? row.engine ?? 'Registro da plataforma')}</small>}</span>;
}
export function ReadinessPanel({ compact = false }: { compact?: boolean }) {
  const { data, error, loading, reload } = useCoachRecords(['athletes', 'readinessScores', 'loadSnapshots', 'deviceSamples', 'athleteResponses', 'staffAssessments', 'activities']);
  const [day, setDay] = useState(dateKey);
  const [selected, setSelected] = useState('');
  const [note, setNote] = useState('');
  const [assessment, setAssessment] = useState('Apto');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  async function save() {
    setSaving(true); setMessage('');
    try {
      await apiRequest('/api/v1/manage/staffAssessments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Percepção da comissão', athleteId: selected, date: day, assessment, note: note.trim(), source: 'Comissão técnica' }) });
      setNote(''); setSelected(''); reload(); setMessage('Avaliação registrada.');
    } catch(e) { setMessage(e instanceof Error ? e.message : 'Falha ao salvar.'); } finally { setSaving(false); }
  }
  return <section className="card coach-panel">
    <SectionHead title="Painel Readiness" subtitle="Carga, devices, percepção do atleta e comissão técnica" />
    <label className="coach-field">Data de referência<input type="date" value={day} onChange={e => setDay(e.target.value)} /></label>
    <State error={error} loading={loading} />
    <div className={compact ? 'readiness-roster' : 'coach-table-wrap'}>
      {(data.athletes ?? []).map(a => {
        const r = latest(data.readinessScores, a.id, day), load = latest(data.loadSnapshots, a.id, day), device = latest(data.deviceSamples, a.id, day), feedback = latest(data.athleteResponses, a.id, day), staff = latest(data.staffAssessments, a.id, day);
        const point = athleteLoad(data.activities ?? [], a.id, day).points.at(-1);
        return <article className="readiness-athlete" key={a.id}><header><b>{String(a.name)}</b><strong>{metric(r?.score ?? r?.readiness)}<small>/100 · {r ? recordDate(r) : 'sem avaliação'}</small></strong></header><div className="readiness-evidence">
          <Evidence row={point ? {id:a.id,date:point.date,source:"RKF · carga interna (u.a.)"} : load}>ATL {metric(point ? point.atl : load?.atl ?? load?.acute)} · CTL {metric(point ? point.ctl : load?.ctl ?? load?.chronic)}{point && <small>Histórico {point.coldStart.stage}</small>}</Evidence><Evidence row={load}>TSS {metric(load?.tss)}</Evidence>
          <Evidence row={device}>Device · {String(device?.provider ?? 'Origem registrada')} · HRV {metric(device?.hrv)} · sono {metric(device?.sleepHours)} h</Evidence>
          <Evidence row={feedback}>PSE {metric(feedback?.pse ?? feedback?.rpe)} · recuperação {metric(feedback?.psr ?? feedback?.recovery)}</Evidence>
          <Evidence row={staff}>Comissão: {String(staff?.assessment ?? '')} · {String(staff?.note ?? '')}</Evidence>
        </div><button className="text-button" onClick={() => setSelected(a.id)}>Registrar percepção da comissão</button></article>;
      })}
    </div>
    {!loading && !error && !data.athletes?.length && <p>Nenhum atleta cadastrado.</p>}
    <p className="coach-explanation">A nota exibida é a prontidão registrada. Os quatro componentes apoiam a decisão técnica; pesos de um novo índice composto aguardam validação do método. Valores ausentes não são convertidos em zero. TSS e carga em u.a. são métricas distintas.</p>
    {selected && <form className="coach-form" onSubmit={e => { e.preventDefault(); void save(); }}><h3>Avaliação · {String(data.athletes?.find(a => a.id === selected)?.name)}</h3><label>Percepção<select value={assessment} onChange={e => setAssessment(e.target.value)}><option>Apto</option><option>Monitorar</option><option>Ajustar sessão</option><option>Recuperação</option></select></label><label>Observações<textarea required minLength={3} value={note} onChange={e => setNote(e.target.value)} /></label><button className="primary-button" disabled={saving}>Salvar avaliação</button><button type="button" className="secondary-button" onClick={() => setSelected('')}>Cancelar</button></form>}
    {message && <p role="status">{message}</p>}
  </section>;
}

export function DailyWater({ onAthlete }: { onAthlete: (id: string) => void }) {
  const { data, error, loading } = useCoachRecords(['athletes', 'workouts', 'goals', 'groups']);
  const day = dateKey();
  const sessions = (data.workouts ?? []).filter(w => recordDate(w) === day && w.status === 'published');
  const assigned = (w: CoachRecord, a: CoachRecord) => {
    if (w.athleteId) return w.athleteId === a.id;
    if (w.targetType === 'athlete') return w.targetId === a.id;
    if (w.targetType === 'group') return Array.isArray(a.groupIds) && a.groupIds.includes(w.targetId) || a.group === w.target || (data.groups ?? []).some(g => g.id === w.targetId && g.name === a.group);
    return w.targetType === 'team' || w.target === 'Equipe inteira';
  };
  return <article className="card coach-panel"><SectionHead title="Na água hoje" subtitle={`${day} · ${sessions.length} sessões publicadas`} /><State error={error} loading={loading} />{sessions.map(w => <section className="daily-session" key={w.id}><h3>{String(w.title)}</h3><p>{String(w.objective ?? w.note ?? 'Objetivo da sessão não informado')} · {metric(w.distanceMeters)} m</p>{(data.athletes ?? []).filter(a => assigned(w, a)).map(a => {
    const goal = (data.goals ?? []).find(g => g.athleteId === a.id && g.status !== 'archived');
    return <button className="daily-athlete" key={a.id} onClick={() => onAthlete(a.id)}><b>{String(a.name)}</b><span>Objetivo: {String(goal?.event ?? a.goalEvent ?? 'Não cadastrado')} {String(goal?.targetTime ?? a.goalTime ?? '')}</span></button>;
  })}</section>)}{!loading && !sessions.length && <p>Nenhum treino publicado para hoje. Publique uma sessão na agenda para mostrá-la aqui.</p>}</article>;
}

export function LoadControl() {
  const { data, error, loading } = useCoachRecords(['athletes', 'loadSnapshots', 'activities']);
  const [day, setDay] = useState(dateKey);
  const [start, setStart] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 27); return dateKey(d); });
  return <><PageTitle kicker="ANÁLISE" title="Controle de Carga" subtitle="Status diário e acumulado de cada atleta, com origem e unidade preservadas." />
    <section className="card coach-panel"><div className="coach-toolbar"><label className="coach-field">Início<input type="date" value={start} max={day} onChange={e => setStart(e.target.value)} /></label><label className="coach-field">Até<input type="date" value={day} min={start} onChange={e => setDay(e.target.value)} /></label></div><State error={error} loading={loading} />
    <div className="coach-table-wrap"><table className="coach-table"><thead><tr>{['Atleta', 'ATL', 'CTL', 'TSS diário', 'TSS acumulado', 'Carga interna diária (u.a.)', 'Carga interna acumulada (u.a.)', 'Status', 'Registro mais recente'].map(s => <th key={s}>{s}</th>)}</tr></thead><tbody>{(data.athletes ?? []).map(a => {
      const rows = (data.loadSnapshots ?? []).filter(r => r.athleteId === a.id && recordDate(r) >= start && recordDate(r) <= day);
      const last = latest(data.loadSnapshots, a.id, day);
      const chronic = athleteLoad(data.activities ?? [], a.id, day);
      const point = chronic.points.at(-1);
      const internalDaily = chronic.points.find(p => p.date === day)?.internalLoadUa;
      const window = chronic.points.filter(p => p.date >= start);
      const daily = rows.filter(r => recordDate(r) === day);
      const sum = (records: CoachRecord[], key: string) => { const vals = records.map(r => r[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)); return vals.length ? vals.reduce((a,b) => a+b, 0) : undefined; };
      return <tr key={a.id}><th>{String(a.name)}</th><td>{metric(point ? point.atl : last?.atl ?? last?.acute)}</td><td>{metric(point ? point.ctl : last?.ctl ?? last?.chronic)}</td><td>{metric(sum(daily, 'tss'))}</td><td>{metric(sum(rows, 'tss'))}</td><td>{metric(internalDaily ?? sum(daily, 'value'))}</td><td>{metric(window.length ? window.reduce((sum,p) => sum+p.internalLoadUa,0) : sum(rows,'value'))}</td><td>{point ? `${point.coldStart.stage} · ${point.date === day ? 'Atualizado hoje' : 'Sem registro hoje'}` : 'Sem histórico RKF'}</td><td>{point ? `${point.date} · RKF` : last ? `${recordDate(last)} · ${String(last.engine ?? last.source ?? 'Registro')}` : 'Sem dados'}</td></tr>;
    })}</tbody></table></div><p className="coach-explanation">TSS aparece somente quando fornecido explicitamente. ATL/CTL preservam os valores e a unidade do motor de origem; o painel não converte automaticamente carga interna em TSS.</p></section><section className="card coach-panel"><SectionHead title="Núcleo RKF · Controle de Carga" subtitle="Método e qualidade do histórico" /><p>Carga interna = PSE × duração em minutos, em unidades arbitrárias. ATL e CTL usam o motor RKF existente, com janelas de 7 e 42 dias ativos. O estágio CS indica a maturidade do histórico; dados insuficientes ficam sem índice.</p><p>Os registros diários e acumulados acima são recalculados quando chegam novas execuções. TSS importado permanece separado da carga interna.</p></section></>;
}

export function CycleOverview({ level = 'macrocycles' }: { level?: 'macrocycles' | 'mesocycles' | 'microcycles' }) {
  const { data, error, loading, reload } = useCoachRecords(['macrocycles', 'mesocycles', 'microcycles']);
  const [edit, setEdit] = useState<{ id?: string; kind: 'macrocycles' | 'mesocycles' | 'microcycles'; parentId?: string } | null>(null);
  const [name, setName] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState(''), [focus, setFocus] = useState('');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  function startEdit(row?: CoachRecord, kind = level, parentId?: string) {
    setEdit({ id: row?.id, kind, parentId }); setName(String(row?.name ?? row?.title ?? '')); setFrom(String(row?.startsOn ?? row?.startDate ?? '').slice(0,10)); setTo(String(row?.endsOn ?? row?.endDate ?? '').slice(0,10)); setFocus(String(row?.focus ?? '')); setMessage('');
  }
  async function saveCycle() {
    if (!edit || from > to) { setMessage('O fim deve ser posterior ao início.'); return; }
    setBusy(true);
    try {
      await apiRequest('/api/v1/manage/' + edit.kind + (edit.id ? '/' + edit.id : ''), { method: edit.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, title: name, startsOn: from, endsOn: to, focus, status: 'planned', ...(edit.parentId ? { [edit.kind === 'mesocycles' ? 'macrocycleId' : 'mesocycleId']: edit.parentId } : {}) }) });
      setEdit(null); reload();
    } catch(e) { setMessage(String(e)); } finally { setBusy(false); }
  }
  const labels = { macrocycles: 'Macrociclo', mesocycles: 'Mesociclo', microcycles: 'Microciclo semanal' };
  const [selected, setSelected] = useState('');
  const roots = data[level] ?? [];
  const visible = selected ? roots.filter(r => r.id === selected) : roots;
  const children = (root: CoachRecord) => level === 'macrocycles' ? (data.mesocycles ?? []).filter(r => r.macrocycleId === root.id) : level === 'mesocycles' ? (data.microcycles ?? []).filter(r => r.mesocycleId === root.id) : [];
  return <section className="card coach-panel"><SectionHead title={`${labels[level]} completo`} subtitle="Planejamento registrado · todas as fases do intervalo" action="Novo ciclo" onAction={() => startEdit()} /><State error={error} loading={loading} /><label className="coach-field">Selecionar ciclo<select value={selected} onChange={e => setSelected(e.target.value)}><option value="">Todos</option>{roots.map(r => <option value={r.id} key={r.id}>{String(r.name ?? r.title ?? r.id)}</option>)}</select></label>
    {visible.map(r => <article className="cycle-row" key={r.id}><h3>{String(r.name ?? r.title ?? r.id)}</h3><p>{String(r.startsOn ?? r.startDate ?? 'Início não definido')} → {String(r.endsOn ?? r.endDate ?? 'Fim não definido')} · {String(r.focus ?? r.status ?? '')}</p><div className="coach-toolbar"><button className="secondary-button" onClick={() => startEdit(r)}>Editar ciclo</button>{level !== 'microcycles' && <button className="secondary-button" onClick={() => startEdit(undefined, level === 'macrocycles' ? 'mesocycles' : 'microcycles', r.id)}>Adicionar {level === 'macrocycles' ? 'mesociclo' : 'microciclo'}</button>}</div>{children(r).map(c => <div key={c.id}><b>{String(c.name ?? c.title ?? c.id)}</b><p>{String(c.startsOn ?? c.startDate ?? '')} → {String(c.endsOn ?? c.endDate ?? '')} · {String(c.focus ?? '')}</p><button className="text-button" onClick={() => startEdit(c, level === 'macrocycles' ? 'mesocycles' : 'microcycles', r.id)}>Editar fase</button>{level === 'macrocycles' && <button className="text-button" onClick={() => startEdit(undefined, 'microcycles', c.id)}>Adicionar microciclo</button>}{level === 'macrocycles' && (data.microcycles ?? []).filter(m => m.mesocycleId === c.id).map(m => <p key={m.id}>{String(m.name ?? m.title ?? m.id)} · {String(m.startsOn ?? m.startDate ?? '')} → {String(m.endsOn ?? m.endDate ?? '')}</p>)}</div>)}</article>)}
    {!loading && !roots.length && <p>Nenhum {labels[level].toLowerCase()} registrado. O painel mostrará o ciclo inteiro assim que o planejamento for salvo.</p>}
    {edit && <ModalShell title={edit.id ? 'Editar ciclo' : 'Criar ciclo'} subtitle={labels[edit.kind]} onClose={() => setEdit(null)}><form className="coach-form coach-panel" onSubmit={e => { e.preventDefault(); void saveCycle(); }}><label>Nome<input required minLength={3} value={name} onChange={e=>setName(e.target.value)} /></label><label>Início<input required type="date" value={from} onChange={e=>setFrom(e.target.value)} /></label><label>Fim<input required type="date" min={from} value={to} onChange={e=>setTo(e.target.value)} /></label><label>Foco<input value={focus} onChange={e=>setFocus(e.target.value)} /></label>{message && <p role="alert">{message}</p>}<button className="primary-button" disabled={busy}>Salvar ciclo</button></form></ModalShell>}
  </section>;
}

export function DailyUpdates() {
  const { data, error, loading } = useCoachRecords(['auditEvents', 'staffAssessments', 'adaptationDecisions']);
  const [day, setDay] = useState(dateKey);
  return <DailyAudit day={day} setDay={setDay} data={data} error={error} loading={loading} />;
}
function DailyAudit({ day, setDay, data, error, loading }: { day: string; setDay: (v: string) => void; data: Record<string, CoachRecord[]>; error: string; loading: boolean }) {
  const [audit, setAudit] = useState<CoachRecord[]>([]);
  const [auditError, setAuditError] = useState('');
  useEffect(() => { let active = true; apiRequest<{ data: CoachRecord[] }>('/api/v1/manage/audit?limit=500').then(r => { if (active) { setAudit(r.data); setAuditError(''); } }).catch(e => { if (active) setAuditError(String(e)); }); return () => { active = false; }; }, [data]);
  const rows = [...audit, ...(data.staffAssessments ?? [])].filter(r => recordDate(r) === day).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return <><PageTitle kicker="ACOMPANHAMENTO" title="Atualização do Dia" subtitle="Alterações registradas e observações da comissão técnica." /><section className="card coach-panel"><label className="coach-field">Data<input type="date" value={day} onChange={e => setDay(e.target.value)} /></label><State error={error || auditError} loading={loading} />{rows.map((r,i) => <article className="cycle-row" key={`${r.id}-${i}`}><b>{String(r.summary ?? r.title ?? 'Atualização')}</b><p>{String(r.note ?? r.action ?? '')} · {String(r.resource ?? 'Comissão técnica')}</p><small>{String(r.createdAt)}</small></article>)}{!loading && !rows.length && <p>Nenhuma alteração registrada nesta data.</p>}<p className="coach-explanation">Mostrando os 500 registros mais recentes da auditoria, além das avaliações da comissão.</p></section></>;
}
