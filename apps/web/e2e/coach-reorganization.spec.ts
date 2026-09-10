import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('novas áreas do treinador e edição de protocolo em desktop/mobile', async ({ page }, testInfo) => {
  const resources: Record<string, Array<Record<string, unknown>>> = {
    athletes: [{id:'ana',name:'Ana Silva',goalEvent:'200 m Livre',goalTime:'2:00.00'}],
    protocols: [], racePlans: [], macrocycles: [{id:'macro',name:'Temporada 2026/27',startsOn:'2026-09-01',endsOn:'2027-07-01'}],
    mesocycles: [{id:'meso',macrocycleId:'macro',name:'Base geral',startsOn:'2026-09-01',endsOn:'2026-10-01'}], microcycles: [],
  };
  const errors: string[]=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(), path=new URL(req.url()).pathname;
    if(path.endsWith('/events')) { await route.abort(); return; }
    let json: unknown={data:[]};
    if(path.endsWith('/auth/me')) json={user:{id:'coach',name:'Treinador',role:'coach',organizationId:'org-demo'}};
    else if(path.endsWith('/coach/automation')) json={counts:{critical:0,high:0,opportunity:0,requiringApproval:0},proposals:[]};
    else if(path.endsWith('/analytics/overview')) json={metrics:{},weekly:[]};
    else if(path.endsWith('/ai/status')) json={available:true};
    else if(path.endsWith('/ai/chat')) { expect(req.postDataJSON().language).toBe('es'); json={reply:'Respuesta de prueba'}; }
    else if(path.includes('/manage/')) {
      const [kind,id]=path.split('/manage/')[1].split('/');
      if(req.method()==='POST') { const record={...req.postDataJSON(),id:'created'};(resources[kind]??=[]).push(record);json=record; }
      else if(req.method()==='PATCH') { const record=resources[kind].find(r=>r.id===id)!;Object.assign(record,req.postDataJSON());json=record; }
      else if(req.method()==='DELETE') {resources[kind]=resources[kind].filter(r=>r.id!==id);json={ok:true};}
      else json={data:resources[kind]??[],total:(resources[kind]??[]).length};
    } else if(path.endsWith('/athletes')) json={data:resources.athletes};
    await route.fulfill({json});
  });
  await page.goto('/pt/coach/protocols');
  await expect(page.getByRole('heading',{name:'Protocolos',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Novo protocolo'}).click();
  await page.getByLabel('Título',{exact:true}).fill('Teste de virada');
  await page.getByLabel('Série, execução, critérios e observações').fill('6 x 50, registrar tempo e ciclos por repetição.');
  await page.getByRole('button',{name:'Salvar rascunho'}).click();
  await expect(page.getByRole('heading',{name:'Teste de virada'})).toBeVisible();
  await page.getByRole('button',{name:'Editar',exact:true}).click();
  await page.getByLabel('Título',{exact:true}).fill('Teste revisado');
  await page.getByRole('button',{name:'Salvar rascunho'}).click();
  await expect(page.getByRole('heading',{name:'Teste revisado'})).toBeVisible();
  for(const [path,heading] of [['today','Treino do dia'],['analytics','Controle de Carga'],['seasons','Macrociclo completo'],['perfect-race','Prova Perfeita'],['inbox','Atualização do Dia']]) {
    await page.goto(`/pt/coach/${path}`); await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  }
  await page.getByLabel('Data',{exact:true}).fill('2026-09-10');
  await page.goto('/pt/coach/perfect-race');
  await page.getByLabel('Tempo (m:ss.cc)').fill('2:00.00');
  await expect(page.locator('output')).toHaveText('1:00.00');
  await page.screenshot({path:`test-results/coach-perfect-race-${testInfo.project.name}.png`,fullPage:true});
  await page.goto('/pt/coach/assistant');
  await page.getByLabel('Idioma da resposta').selectOption('es');
  await page.getByLabel('Mensagem para o assistente').fill('Como organizar o treino?');
  await page.getByRole('button',{name:'Enviar mensagem'}).click();
  await expect(page.getByText('Respuesta de prueba')).toBeVisible();
  expect(errors).toEqual([]);
});

test('abrir análise leva ao estúdio e salva desenhos, notas e comparação', async ({ page }, testInfo) => {
  const video: Record<string, unknown> = {id:'video-test',title:'Vídeo de validação',url:'/fixture.webm'};
  await page.route('**/api/v1/**', async route => {
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/events')) {await route.abort();return;}
    let json: unknown={data:[]};
    if(path.endsWith('/auth/me')) json={user:{id:'coach',name:'Treinador',role:'coach',organizationId:'org-demo'}};
    else if(path.endsWith('/coach/automation')) json={counts:{},proposals:[]};
    else if(path.endsWith('/analytics/overview')) json={metrics:{},weekly:[]};
    else if(path.endsWith('/manage/videos/video-test')) {
      if(route.request().method()==='PATCH') Object.assign(video,route.request().postDataJSON());
      json=video;
    } else if(path.endsWith('/manage/videos')) json={data:[video,{id:'comparison',title:'Vídeo comparativo',url:'/fixture.webm'}],total:2};
    await route.fulfill({json});
  });
  await page.goto('/pt/coach/videos');
  // Generate a real, synthetic, browser-encoded video: no athlete files or external requests.
  const base64=process.env.VIDEO_REVIEW_FIXTURE ? readFileSync(process.env.VIDEO_REVIEW_FIXTURE).toString('base64') : await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const context=canvas.getContext('2d')!; context.fillStyle='#164675';context.fillRect(0,0,320,180);
    const stream=canvas.captureStream(30), recorder=new MediaRecorder(stream,{mimeType:'video/webm'});
    const chunks: BlobPart[]=[];recorder.ondataavailable=e=>chunks.push(e.data);
    const result=new Promise<string>(resolve=>recorder.onstop=async()=>{
      const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());
      resolve(btoa(Array.from(bytes,b=>String.fromCharCode(b)).join('')));stream.getTracks().forEach(t=>t.stop());
    });recorder.start();setTimeout(()=>recorder.stop(),400);return result;
  });
  await page.route('**/fixture.webm',route=>{
    const bytes=Buffer.from(base64,'base64');const range=route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
    const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
    return route.fulfill({status:range?206:200,body:bytes.subarray(start,end+1),contentType:process.env.VIDEO_REVIEW_FIXTURE?'video/mp4':'video/webm',headers:{'accept-ranges':'bytes',...(range?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})}});
  });
  await page.getByRole('button',{name:'Abrir análise'}).first().click();
  await expect(page.getByRole('dialog',{name:'Revisão de vídeo'})).toBeVisible();
  await expect(page.getByText('MOVIMENTO AGORA',{exact:true})).toHaveCount(0);
  const primary=page.locator('.studio-frame video');
  await expect.poll(()=>primary.evaluate((el: HTMLVideoElement)=>el.readyState)).toBeGreaterThan(1);
  await page.getByLabel('Comparar com').selectOption('comparison');
  await expect(page.locator('.studio-viewers video')).toHaveCount(2);
  await page.getByRole('combobox',{name:'Velocidade',exact:true}).selectOption('0.25');
  await expect.poll(()=>primary.evaluate((el: HTMLVideoElement)=>el.playbackRate)).toBe(0.25);
  await page.getByRole('button',{name:'Próximo quadro',exact:true}).click();
  await expect.poll(()=>primary.evaluate((el: HTMLVideoElement)=>el.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Linha',exact:true}).click();
  const overlay=page.locator('.studio-drawing');
  await overlay.click({position:{x:30,y:30}});await overlay.click({position:{x:100,y:80}});
  await expect(overlay.locator('polyline')).toHaveCount(1);
  await page.getByRole('button',{name:'Salvar revisão',exact:true}).click();
  await expect(page.getByText('Revisão salva.',{exact:true})).toBeVisible();
  expect((video.coachReview as {drawings:unknown[]}).drawings).toHaveLength(1);
  await page.getByRole('button',{name:'Virada',exact:true}).click();
  await page.getByRole('textbox',{name:/Observação de Virada/}).fill('Aproximar os pés da parede e acelerar a saída.');
  await page.getByLabel('Síntese para o atleta').fill('Prioridade: posição de saída da virada.');
  await page.getByRole('button',{name:'Salvar revisão',exact:true}).click();
  await expect(page.getByText('Revisão salva.',{exact:true})).toBeVisible();
  await page.screenshot({path:`test-results/video-studio-${testInfo.project.name}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.reload();
  await page.getByRole('button',{name:'Abrir análise'}).first().click();
  await expect(page.getByRole('button',{name:/Desenho 1/})).toBeVisible();
  await expect(page.getByRole('textbox',{name:/Observação de Virada/})).toHaveValue('Aproximar os pés da parede e acelerar a saída.');
  await expect(page.getByLabel('Síntese para o atleta')).toHaveValue('Prioridade: posição de saída da virada.');
});
