import { useEffect, useState } from 'react';
import { apiRequest, subscribeToLiveEvents } from './api';
import { computeChronicSeries } from '@natacao/domain';

export type CoachRecord = { id: string; [key: string]: unknown };
export function useCoachRecords(kinds: string[]) {
  const key = kinds.join(',');
  const [data, setData] = useState<Record<string, CoachRecord[]>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeToLiveEvents(() => setVersion(v => v + 1)), []);
  useEffect(() => {
    let active = true;
    async function read(kind: string) {
      const records: CoachRecord[] = [];
      for (let offset = 0; ; offset += 500) {
        const page = await apiRequest<{ data: CoachRecord[]; total?: number }>(`/api/v1/manage/${kind}?limit=500&offset=${offset}`);
        records.push(...page.data);
        if (page.data.length < 500 || records.length >= (page.total ?? records.length)) break;
      }
      return [kind, records] as const;
    }
    setLoading(true);
    Promise.all(key.split(',').map(read)).then(entries => {
      if (active) { setData(Object.fromEntries(entries)); setError(''); }
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Não foi possível carregar os dados.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [key, version]);
  return { data, error, loading, reload: () => setVersion(v => v + 1) };
}
export function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function recordDate(row: CoachRecord) { return String(row.date ?? row.measuredAt ?? row.startedAt ?? row.createdAt ?? '').slice(0, 10); }
export function latest(rows: CoachRecord[] = [], athleteId: string, day: string) {
  return rows.filter(r => r.athleteId === athleteId && recordDate(r) <= day).sort((a, b) => recordDate(b).localeCompare(recordDate(a)) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];
}
export function metric(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '—'; }
export function athleteLoad(rows: CoachRecord[], athleteId: string, until: string) {
  const sessions = rows.filter(r => r.type === 'rkf-load-session' && r.athleteId === athleteId && recordDate(r) <= until).flatMap(r => {
    const pse = r.pse == null || r.pse === '' ? NaN : Number(r.pse), durationMinutes = Number(r.durationMinutes), date = String(r.date ?? '');
    return Number.isFinite(pse) && pse >= 0 && pse <= 10 && Number.isFinite(durationMinutes) && durationMinutes > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) ? [{ athleteId, date, pse, durationMinutes }] : [];
  });
  return computeChronicSeries(sessions, athleteId);
}
export function parseSwimTime(value: string): number | null {
  if (!/^\d+(?::[0-5]\d)?(?:[.,]\d{1,3})?$/.test(value.trim())) return null;
  const parts = value.trim().replace(',', '.').split(':').map(Number);
  const result = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
  return result > 0 ? result : null;
}
export function formatSwimTime(seconds: number) {
  const hundredths = Math.round(seconds * 100);
  return `${Math.floor(hundredths / 6000)}:${(hundredths % 6000 / 100).toFixed(2).padStart(5, '0')}`;
}
