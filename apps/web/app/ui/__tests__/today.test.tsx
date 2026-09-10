import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Today } from '../views-primary';
import { apiRequest } from '../api';
import { dateKey } from '../coach-data';
vi.mock('../api', () => ({ apiRequest: vi.fn(), API_URL: '', importFile: vi.fn(), mediaUrl: vi.fn(), subscribeToLiveEvents: () => () => {} }));
const roster = [{ id:'a', name:'Atleta A', goalEvent:'200 livre', goalTime:'2:00', group:'Equipe' }, { id:'b', name:'Atleta B', group:'Equipe' }];
beforeEach(() => { vi.mocked(apiRequest).mockImplementation(async path => {
  if(path === '/api/v1/athletes' || path.startsWith('/api/v1/manage/athletes')) return { data:roster };
  if(path.startsWith('/api/v1/manage/workouts')) return { data:[{id:'w', title:'Sessão real do dia', date:dateKey(), status:'published', targetType:'athlete', targetId:'a', distanceMeters:3000}] };
  if(path.startsWith('/api/v1/manage/readinessScores')) return { data:[{id:'r', athleteId:'a', date:dateKey(), score:74}] };
  if(path === '/api/v1/coach/automation') return {counts:{critical:0,high:0,opportunity:0,requiringApproval:0},proposals:[]};
  if(path.startsWith('/api/v1/analytics')) return {metrics:{},weekly:[]};
  return {data:[]};
}); });
function mount() { render(<Today onCreate={()=>{}} onNavigate={()=>{}} onAthlete={()=>{}} onNotify={()=>{}} />); }
describe('Hoje operacional',()=>{
  it('mostra treino publicado para a data e objetivo do atleta atribuído',async()=>{ mount(); expect(await screen.findByText('Sessão real do dia')).toBeInTheDocument(); expect(await screen.findByText('Objetivo: 200 livre 2:00')).toBeInTheDocument(); expect(screen.queryByText('Ritmo de prova · 200 Livre')).not.toBeInTheDocument(); });
  it('exibe prontidão registrada sem fabricar nota para atleta sem avaliação',async()=>{ mount(); expect(await screen.findByText('74')).toBeInTheDocument(); expect(screen.getByText('/100 · sem avaliação')).toBeInTheDocument(); });
  it('preserva a contagem do plantel e o título solicitado',async()=>{ mount(); expect(await screen.findByText('2 no plantel')).toBeInTheDocument(); expect(screen.getByText('Treino do dia')).toBeInTheDocument(); });
});
