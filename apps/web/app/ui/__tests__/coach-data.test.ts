import { describe, it, expect } from 'vitest';
import { athleteLoad, formatSwimTime, latest, parseSwimTime } from '../coach-data';
import { angleDegrees } from '../coach-eye';
describe('Dados de operação do treinador',()=>{
  it('valida o tempo e arredonda a virada de minuto corretamente',()=>{
    expect(parseSwimTime('1:58,50')).toBe(118.5);
    expect(parseSwimTime('1:80')).toBeNull();
    expect(parseSwimTime('-2')).toBeNull();
    expect(formatSwimTime(59.999)).toBe('1:00.00');
  });
  it('isola atleta e data e preserva cold start do motor',()=>{
    const rows=[{id:'a',athleteId:'ana',type:'rkf-load-session',date:'2026-09-01',pse:6,durationMinutes:60},{id:'b',athleteId:'caio',type:'rkf-load-session',date:'2026-09-01',pse:9,durationMinutes:90},{id:'c',athleteId:'ana',type:'rkf-load-session',date:'2026-09-10',pse:8,durationMinutes:90}];
    const load=athleteLoad(rows,'ana','2026-09-02');
    expect(load.points).toHaveLength(1); expect(load.points[0].internalLoadUa).toBe(360); expect(load.points[0].ctl).toBeNull();
  });
  it('escolhe evidência anterior à data selecionada',()=>{
    expect(latest([{id:'old',athleteId:'a',date:'2026-09-01'},{id:'future',athleteId:'a',date:'2026-09-11'}],'a','2026-09-10')?.id).toBe('old');
  });
  it('mede ângulos 2D e rejeita ponto sem direção',()=>{expect(angleDegrees({x:1,y:0},{x:0,y:0},{x:0,y:1})).toBeCloseTo(90);expect(angleDegrees({x:0,y:0},{x:0,y:0},{x:1,y:1})).toBeNull();});
});
