"use client";

import { useEffect, useRef, useState } from 'react';
import { Check, Circle, CornerDownRight, Maximize2, Mic, MousePointer2, Pause, Play, Plus, Save, SkipBack, SkipForward, Trash2, Undo2 } from 'lucide-react';
import { apiRequest, mediaUrl, subscribeToLiveEvents, uploadFile } from './api';
import { ModalShell } from './components';
import { VisionCoachPanel } from './vision-coach';
import { TrackAssignmentPanel } from './track-assignment';
import { PoseTrackingLayer } from './pose/LiveAnalysis';
import type { TrackedKeyframe } from './pose/server-track';
import type { MotionAnalysis } from './modals';
import './video-studio.css';

type Point = { x: number; y: number };
type Drawing = { tool: 'line' | 'circle' | 'angle'; points: Point[]; time: number };
type VoiceNote = { url: string; time: number };
type Marker = { id: string; time: number; label: string; category: string; note?: string; confidence?: number };
type Measurement = { start: number; end: number | null; cycles: string; distance: string };
type Review = { drawings?: Drawing[]; voice?: VoiceNote[]; measurement?: Measurement };
type Video = { id: string; status?: string; title?: string; event?: string; athlete?: string; url?: string; thumbnailUrl?: string; feedback?: string; durationSeconds?: number; analysisStatus?: string; analysis?: MotionAnalysis; coachReview?: Review; manualEvents?: Marker[] };
const emptyMeasurement: Measurement = { start: 0, end: null, cycles: '', distance: '' };
const categories = ['Saída', 'Velocidade', 'Virada', 'Ritmo', 'Chegada'];
export const studioTime = (seconds: number) => {
  const value = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 100);
  return `${String(Math.floor(value / 6000)).padStart(2,'0')}:${(value % 6000 / 100).toFixed(2).padStart(5,'0')}`;
};
export function angleDegrees(a: Point, b: Point, c: Point) {
  const denominator = Math.hypot(a.x-b.x,a.y-b.y) * Math.hypot(c.x-b.x,c.y-b.y);
  return denominator ? Math.acos(Math.max(-1,Math.min(1,((a.x-b.x)*(c.x-b.x)+(a.y-b.y)*(c.y-b.y))/denominator))) * 180 / Math.PI : null;
}
async function toWav(blob: Blob): Promise<File> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    const bytes = audio.length * audio.numberOfChannels * 2;
    const buffer = new ArrayBuffer(44 + bytes), view = new DataView(buffer);
    const word = (offset: number, text: string) => [...text].forEach((char,i) => view.setUint8(offset+i,char.charCodeAt(0)));
    word(0,'RIFF'); view.setUint32(4,36+bytes,true); word(8,'WAVE'); word(12,'fmt ');
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,audio.numberOfChannels,true);
    view.setUint32(24,audio.sampleRate,true); view.setUint32(28,audio.sampleRate*audio.numberOfChannels*2,true);
    view.setUint16(32,audio.numberOfChannels*2,true); view.setUint16(34,16,true); word(36,'data'); view.setUint32(40,bytes,true);
    for(let i=0;i<audio.length;i++) for(let ch=0;ch<audio.numberOfChannels;ch++) {
      const sample=Math.max(-1,Math.min(1,audio.getChannelData(ch)[i]));
      view.setInt16(44+(i*audio.numberOfChannels+ch)*2,sample<0?sample*32768:sample*32767,true);
    }
    return new File([buffer], `comentario-${Date.now()}.wav`, { type: 'audio/wav' });
  } finally { await context.close(); }
}

export function VideoReview({ videoId, onClose, onSave }: { videoId: string; onClose: () => void; onSave: () => void }) {
  const [record,setRecord]=useState<Video | null>(null), [catalog,setCatalog]=useState<Video[]>([]);
  const [loading,setLoading]=useState(true), [error,setError]=useState(''), [status,setStatus]=useState('');
  const [drawings,setDrawings]=useState<Drawing[]>([]), [points,setPoints]=useState<Point[]>([]), [voice,setVoice]=useState<VoiceNote[]>([]);
  const [markers,setMarkers]=useState<Marker[]>([]), [feedback,setFeedback]=useState('');
  const [measurement,setMeasurement]=useState<Measurement>(emptyMeasurement);
  const [dirty,setDirty]=useState(false), [busy,setBusy]=useState(false), [recording,setRecording]=useState(false);
  const [tool,setTool]=useState<Drawing['tool'] | 'play'>('play'), [tab,setTab]=useState('Observações');
  const [time,setTime]=useState(0), [duration,setDuration]=useState(0), [rate,setRate]=useState(1), [fps,setFps]=useState(30), [ratio,setRatio]=useState(16/9), [playing,setPlaying]=useState(false);
  const [comparison,setComparison]=useState(''), [linked,setLinked]=useState(true), [offset,setOffset]=useState(0);
  const [showPose,setShowPose]=useState(false), [keyframes,setKeyframes]=useState<TrackedKeyframe[]>([]);
  const player=useRef<HTMLVideoElement>(null), second=useRef<HTMLVideoElement>(null), stage=useRef<HTMLDivElement>(null);
  const recorder=useRef<MediaRecorder | null>(null), mounted=useRef(true), timer=useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysis=record?.analysis, other=catalog.find(v=>v.id===comparison);
  const canTrack=analysis?.engine==='AquaVision' && Boolean(analysis.keyframeSegments?.length || analysis.keyframes?.length);
  const automatic=(analysis?.events ?? []).filter(e=>Number.isFinite(e.time));
  const pending=Boolean(record && ['pending','processing','queued'].includes(record.analysisStatus ?? ''));
  const change=()=>{setDirty(true);setStatus('');};
  useEffect(()=>{
    mounted.current=true; let active=true;
    const previous=document.body.style.overflow; document.body.style.overflow='hidden';
    apiRequest<Video>(`/api/v1/manage/videos/${videoId}`).then(r=>{if(!active)return;
      setRecord(r);setDrawings(r.coachReview?.drawings??[]);setVoice(r.coachReview?.voice??[]);setMeasurement(r.coachReview?.measurement??emptyMeasurement);
      setMarkers(r.manualEvents??[]);setFeedback(r.feedback??'');setDuration(r.durationSeconds??r.analysis?.metadata.durationSeconds??0);
      setFps(Math.max(1,Math.min(240,r.analysis?.metadata.fps||30)));setError('');
    }).catch(e=>{if(active)setError(String(e));}).finally(()=>{if(active)setLoading(false);});
    apiRequest<{data:Video[]}>('/api/v1/manage/videos?limit=500').then(r=>{if(active)setCatalog(r.data);}).catch(()=>{if(active)setStatus('Não foi possível carregar o acervo para comparação.');});
    return ()=>{active=false;mounted.current=false;document.body.style.overflow=previous;
      if(timer.current)clearTimeout(timer.current);if(recorder.current?.state==='recording')recorder.current.stop();recorder.current?.stream.getTracks().forEach(t=>t.stop());};
  },[videoId]);
  useEffect(()=>subscribeToLiveEvents(event=>{
    if(event.resource!=='videos'||event.resourceId!==videoId)return;
    // Live processing updates never overwrite unsaved observations or drawings.
    void apiRequest<Video>(`/api/v1/manage/videos/${videoId}`).then(r=>{if(mounted.current)setRecord(current=>current?{...current,analysis:r.analysis,analysisStatus:r.analysisStatus}:current);}).catch(()=>undefined);
  }),[videoId]);
  useEffect(()=>{
    if(!canTrack||!showPose){setKeyframes([]);return;} let active=true;
    const timer=setTimeout(()=>void apiRequest<{keyframes:TrackedKeyframe[]}>(`/api/v1/videos/${videoId}/keyframes?from=${Math.max(0,time-5)}&to=${time+5}`).then(r=>{if(active)setKeyframes(r.keyframes);}).catch(()=>{if(active)setKeyframes([]);}),100);
    return ()=>{active=false;clearTimeout(timer);};
  },[videoId,canTrack,showPose,time]);
  useEffect(()=>{if(player.current)player.current.playbackRate=rate;if(second.current)second.current.playbackRate=rate;},[rate,comparison]);
  useEffect(()=>{if(!dirty&&!recording)return;const protect=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);},[dirty,recording]);
  function syncComparison(at:number,resume=false){
    const video=second.current;if(!video||!linked)return;
    const target=at+offset, end=Number.isFinite(video.duration)&&video.duration>0?video.duration:Infinity;
    if(target<0||target>=end){video.pause();video.currentTime=Math.max(0,Math.min(end,target));return;}
    if(Math.abs(video.currentTime-target)>.12||resume&&video.paused)video.currentTime=target;
    video.playbackRate=rate;
    if(resume&&video.paused)void video.play().catch(()=>setError('Não foi possível reproduzir o vídeo comparativo.'));
  }
  function seek(next: number) {
    const target=Math.max(0,Math.min(duration || Infinity,next));
    if(player.current)player.current.currentTime=target;
    syncComparison(target,!player.current?.paused);
    setTime(target);setPoints([]);
  }
  function pause(){player.current?.pause();second.current?.pause();setPlaying(false);}
  function frame(direction:number){pause();seek((player.current?.currentTime??time)+direction/fps);}
  async function toggle(){if(playing){pause();return;}try{syncComparison(player.current?.currentTime??time);await player.current?.play();syncComparison(player.current?.currentTime??time,true);}catch{setError('Não foi possível iniciar a reprodução. Verifique o arquivo de vídeo.');}}
  function close(){if(busy||recording){setError('Conclua a gravação ou o salvamento antes de fechar.');return;}if(!dirty||window.confirm('Há alterações não salvas. Deseja sair sem salvar?'))onClose();}
  async function save(){
    if(measurement.end!==null&&measurement.end<=measurement.start){setError('O fim do trecho deve ser posterior ao início.');setTab('Medições');return;}
    if(measurement.cycles!==''&&(!Number.isInteger(Number(measurement.cycles))||Number(measurement.cycles)<0)||measurement.distance!==''&&(!Number.isFinite(Number(measurement.distance))||Number(measurement.distance)<=0)){setError('Informe ciclos inteiros a partir de zero e uma distância positiva.');setTab('Medições');return;}
    setBusy(true);setError('');try{
    await apiRequest(`/api/v1/manage/videos/${videoId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({coachReview:{version:2,drawings,voice,measurement},manualEvents:markers,feedback,status:'reviewed',reviewedAt:new Date().toISOString(),sourceReview:'Revisão técnica manual'})});
    setDirty(false);setRecord(r=>r?{...r,status:'reviewed'}:r);setStatus('Revisão salva.');
  }catch(e){setError(String(e));}finally{setBusy(false);}}
  async function recordVoice(){
    if(recording){recorder.current?.stop();return;}setBusy(true);setError('');let stream:MediaStream|undefined;
    try{stream=await navigator.mediaDevices.getUserMedia({audio:true});if(!mounted.current){stream.getTracks().forEach(t=>t.stop());return;}
      const capture=stream, media=new MediaRecorder(capture), chunks:BlobPart[]=[], at=player.current?.currentTime??time;recorder.current=media;
      media.ondataavailable=e=>chunks.push(e.data);media.onstop=async()=>{capture.getTracks().forEach(t=>t.stop());if(timer.current)clearTimeout(timer.current);if(!mounted.current)return;setRecording(false);setBusy(true);
        try{const file=await toWav(new Blob(chunks,{type:media.mimeType}));const result=await uploadFile(file,'documents',{title:'Comentário de revisão',referenceType:'video',referenceId:videoId});
          if(typeof result.url!=='string')throw Error('O áudio foi enviado sem endereço de reprodução.');
          if(mounted.current){setVoice(v=>[...v,{url:result.url as string,time:at}]);change();}
        }catch(e){if(mounted.current)setError(String(e));}finally{if(mounted.current)setBusy(false);}};
      media.start();setRecording(true);setBusy(false);timer.current=setTimeout(()=>{if(media.state==='recording')media.stop();},120000);
    }catch(e){stream?.getTracks().forEach(t=>t.stop());if(mounted.current){setError(`Não foi possível gravar: ${String(e)}`);setBusy(false);}}
  }
  function addMarker(category:string){pause();setMarkers(m=>[...m,{id:crypto.randomUUID(),time:player.current?.currentTime??time,label:category,category:category.toLowerCase(),note:''}]);setTab('Observações');change();}
  const interval=measurement.end!==null?measurement.end-measurement.start:0;
  const manualCadence=interval>0&&measurement.cycles!==''?Number(measurement.cycles)/interval*60:null;
  const manualSpeed=interval>0&&Number(measurement.distance)>0?Number(measurement.distance)/interval:null;
  const title=record?.athlete ? `${record.athlete} · Revisão de vídeo` : 'Revisão de vídeo';
  return <ModalShell title={title} subtitle={record?.event??record?.title??'Estúdio técnico RKF'} wide className="video-studio" onClose={close}>
    <div className="studio-root" onKeyDown={e=>{const target=e.target as HTMLElement;if(target.closest('input,textarea,select,button,a'))return;
      if(e.code==='Space'){e.preventDefault();void toggle();}if(e.key==='ArrowRight'){e.preventDefault();frame(1);}if(e.key==='ArrowLeft'){e.preventDefault();frame(-1);}}}>
      {loading?<div className="studio-loading" role="status">Carregando vídeo e revisão…</div>:!record?<div className="studio-loading" role="alert">{error||'Vídeo não encontrado.'}<button onClick={onClose}>Voltar ao acervo</button></div>:<>
      <div className="studio-topline"><span><i className={dirty?'unsaved':''}/>{dirty?'Alterações não salvas':'Revisão técnica'}{pending?' · processamento em andamento':''}</span><label>Comparar com<select aria-label="Comparar com" value={comparison} onChange={e=>{pause();setComparison(e.target.value);setOffset(0);}}><option value="">Selecionar outro vídeo</option>{catalog.filter(v=>v.id!==videoId&&v.url).map(v=><option value={v.id} key={v.id}>{v.athlete?`${v.athlete} · `:''}{v.event??v.title??v.id}</option>)}</select></label></div>
      <div className="studio-layout" inert={busy}><div className="studio-editing">
        <div className={`studio-viewers ${other?'is-comparing':''}`} ref={stage} tabIndex={0} aria-label="Área de reprodução: espaço para reproduzir, setas para quadros">
          <div className="studio-screen"><div className="studio-frame" style={{aspectRatio:ratio,maxWidth:`max(260px, calc((100dvh - 480px) * ${ratio}))`}}>
            <video ref={player} src={mediaUrl(record.url)} poster={mediaUrl(record.thumbnailUrl)} playsInline preload="metadata"
              onLoadedMetadata={e=>{const v=e.currentTarget;if(Number.isFinite(v.duration))setDuration(v.duration);if(v.videoWidth&&v.videoHeight)setRatio(v.videoWidth/v.videoHeight);v.playbackRate=rate;}}
              onTimeUpdate={e=>{setTime(e.currentTarget.currentTime);syncComparison(e.currentTarget.currentTime,!e.currentTarget.paused);}}
              onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={pause} onError={()=>setError('O arquivo não pôde ser reproduzido. Verifique se o vídeo foi enviado em um formato compatível.')} />
            {showPose&&canTrack&&<PoseTrackingLayer videoRef={player} active serverKeyframes={keyframes} serverTrackingAvailable serverPersonIds={analysis?.people?.map(p=>p.id)??[]} coverageEndsAt={analysis?.metadata.keyframesTruncatedAt??null}/>}
            <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className={`studio-drawing ${tool==='play'?'is-passive':''}`} aria-label="Desenhar sobre o vídeo" onPointerDown={e=>{
              if(tool==='play'||busy)return;pause();const box=e.currentTarget.getBoundingClientRect();const point={x:(e.clientX-box.left)/box.width*1000,y:(e.clientY-box.top)/box.height*1000};const next=[...points,point];
              if(next.length===(tool==='angle'?3:2)){setDrawings(d=>[...d,{tool,points:next,time:player.current?.currentTime??time}]);setPoints([]);change();}else setPoints(next);
            }}>{drawings.filter(d=>Math.abs(d.time-time)<.5).map((d,i)=><g key={i} stroke="#ffda00" fill="none" strokeWidth="4" vectorEffect="non-scaling-stroke">{d.tool==='circle'?<ellipse cx={(d.points[0].x+d.points[1].x)/2} cy={(d.points[0].y+d.points[1].y)/2} rx={Math.abs(d.points[1].x-d.points[0].x)/2} ry={Math.abs(d.points[1].y-d.points[0].y)/2}/>:<polyline points={d.points.map(p=>`${p.x},${p.y}`).join(' ')}/>} {d.tool==='angle'&&<text x={d.points[1].x+15} y={d.points[1].y-15} stroke="none" fill="#ffda00" fontSize="35">{angleDegrees(...d.points.map(p=>({x:p.x*ratio,y:p.y})) as [Point,Point,Point])?.toFixed(1)??'—'}°</text>}</g>)}{points.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r="8" fill="#ffda00"/>)}</svg>
            {!playing&&tool==='play'&&<button className="studio-big-play" aria-label="Reproduzir vídeo" onClick={()=>void toggle()}><Play size={28} fill="currentColor"/></button>}
          </div><span className="studio-screen-label">Vídeo principal</span></div>
          {other&&<div className="studio-screen"><video ref={second} src={mediaUrl(other.url)} controls={!linked} playsInline onLoadedMetadata={e=>{e.currentTarget.playbackRate=rate;syncComparison(player.current?.currentTime??time,Boolean(playing));}} onError={()=>setError('O vídeo de comparação não pôde ser reproduzido.')}/><span className="studio-screen-label">{other.athlete??'Comparação'}</span></div>}
        </div>
        <div className="studio-transport"><button aria-label={playing?'Pausar':'Reproduzir'} className="studio-play" onClick={()=>void toggle()}>{playing?<Pause size={20}/>:<Play size={20}/>}</button><button aria-label="Quadro anterior" title="Quadro anterior" onClick={()=>frame(-1)}><SkipBack size={18}/></button><button aria-label="Próximo quadro" title="Próximo quadro" onClick={()=>frame(1)}><SkipForward size={18}/></button><output className="studio-time">{studioTime(time)} <span>/ {studioTime(duration)}</span></output><label className="studio-rate"><span>Velocidade</span><select aria-label="Velocidade" value={rate} onChange={e=>setRate(Number(e.target.value))}>{[.1,.25,.5,1,1.5,2].map(r=><option key={r} value={r}>{r}×</option>)}</select></label><button aria-label="Tela cheia" title="Tela cheia" onClick={()=>void (document.fullscreenElement?document.exitFullscreen():stage.current?.requestFullscreen())?.catch(()=>setError('Tela cheia indisponível neste navegador.'))}><Maximize2 size={18}/></button></div>
        <div className="studio-timeline"><input aria-label="Posição do vídeo" type="range" min={0} max={duration||1} step={.01} value={Math.min(time,duration||1)} onChange={e=>seek(Number(e.target.value))}/><div className="studio-ticks">{markers.map(m=><button key={m.id} title={`${m.label} · ${studioTime(m.time)}`} aria-label={`Ir para ${m.label} em ${studioTime(m.time)}`} style={{left:`${duration?Math.min(100,m.time/duration*100):0}%`}} onClick={()=>seek(m.time)}/>)}<span>00:00</span><span>{studioTime(duration)}</span></div></div>
        {other&&<div className="studio-compare-bar"><label><input type="checkbox" checked={linked} onChange={e=>{pause();setLinked(e.target.checked);}}/>Reprodução sincronizada</label><button onClick={()=>{setOffset((second.current?.currentTime??0)-(player.current?.currentTime??0));setLinked(true);setStatus('Pontos de comparação alinhados.');}}>Alinhar estes instantes</button><small>Desative a sincronização para ajustar o segundo vídeo.</small></div>}
        <div className="studio-tools" aria-label="Ferramentas de desenho">{(['play','line','circle','angle'] as const).map((t,i)=>{const Icon=[MousePointer2,CornerDownRight,Circle,CornerDownRight][i];return <button key={t} aria-pressed={tool===t} onClick={()=>{setTool(t);setPoints([]);if(t!=='play')pause();}}><Icon size={17}/>{['Cursor','Linha','Círculo','Ângulo'][i]}</button>;})}<span/><button disabled={!drawings.length||busy} onClick={()=>{setDrawings(d=>d.slice(0,-1));change();}}><Undo2 size={17}/>Desfazer</button><button disabled={busy} className={recording?'is-recording':''} onClick={()=>void recordVoice()}><Mic size={17}/>{recording?'Parar gravação':'Gravar voz'}</button></div>
        <p className="studio-help">{tool==='play'?'Espaço: reproduzir ou pausar · Setas: quadro a quadro':`${tool==='angle'?'Marque três pontos; o segundo é o vértice do ângulo.':'Marque dois pontos sobre a imagem.'} O desenho fica associado a ${studioTime(time)}.`}</p>
        <div className="studio-markers"><span>Marcar momento</span>{categories.map(c=><button key={c} disabled={busy} onClick={()=>addMarker(c)}><Plus size={14}/>{c}</button>)}</div>
        {!!drawings.length&&<div className="studio-drawing-list">{drawings.map((d,i)=><button key={i} onClick={()=>{pause();seek(d.time);}}>Desenho {i+1}<span>{studioTime(d.time)}</span></button>)}</div>}
        {!!voice.length&&<div className="studio-voice-list">{voice.map((v,i)=><div key={i}><button onClick={()=>seek(v.time)}>Voz · {studioTime(v.time)}</button><audio controls src={mediaUrl(v.url)}/><button aria-label={`Remover comentário ${i+1}`} disabled={busy} onClick={()=>{setVoice(rows=>rows.filter((_,n)=>n!==i));change();}}><Trash2 size={16}/></button></div>)}</div>}
      </div><aside className="studio-notebook"><div className="studio-tabs" role="tablist" aria-label="Painéis da revisão">{['Observações','Medições','Assistente'].map(t=><button key={t} role="tab" aria-selected={tab===t} onClick={()=>setTab(t)}>{t}</button>)}</div>
        <div className="studio-tab-content" role="tabpanel" aria-label={tab}>
          {tab==='Observações'&&<><div className="studio-section-heading"><h3>Notas do treinador</h3><span>{markers.length}</span></div><p className="studio-muted">Marque um momento no vídeo e descreva o ajuste técnico.</p>
            {!markers.length&&<div className="studio-empty"><CornerDownRight size={24}/><strong>A primeira observação começa no vídeo</strong><p>Use Saída, Virada ou outra categoria abaixo do player.</p></div>}
            {[...markers].sort((a,b)=>a.time-b.time).map(m=><article className="studio-note" key={m.id}><header><button onClick={()=>{pause();seek(m.time);}}>{studioTime(m.time)}</button><strong>{m.label}</strong><button aria-label={`Excluir ${m.label} em ${studioTime(m.time)}`} disabled={busy} onClick={()=>{setMarkers(rows=>rows.filter(r=>r.id!==m.id));change();}}><Trash2 size={15}/></button></header><textarea aria-label={`Observação de ${m.label} em ${studioTime(m.time)}`} value={m.note??''} disabled={busy} placeholder="O que observar e como corrigir?" onChange={e=>{setMarkers(rows=>rows.map(r=>r.id===m.id?{...r,note:e.target.value}:r));change();}}/></article>)}
            <label className="studio-field">Síntese para o atleta<textarea value={feedback} disabled={busy} onChange={e=>{setFeedback(e.target.value);change();}} placeholder="Prioridade técnica para a próxima sessão"/></label>
            {!!automatic.length&&<details className="studio-evidence"><summary>{automatic.length} eventos do processamento automático</summary><p>Revise estes eventos antes de utilizá-los como evidência técnica. {analysis?.engine==='AquaMotion'?'O processamento disponível mede movimento global da cena.':''}</p>{automatic.map(e=><button key={e.id} onClick={()=>{pause();seek(e.time);}}><span>{studioTime(e.time)}</span><b>{e.label}</b><small>{analysis?.engine}{typeof e.confidence==='number'&&Number.isFinite(e.confidence)?` · ${e.confidence}% confiança`:''}</small></button>)}</details>}
          </>}
          {tab==='Medições'&&<><h3>Cronometragem do trecho</h3><p className="studio-muted">Escolha os instantes e registre o que contou no vídeo.</p><div className="studio-interval"><button onClick={()=>{setMeasurement(m=>({...m,start:time}));change();}}>Definir início<strong>{studioTime(measurement.start)}</strong></button><button onClick={()=>{setMeasurement(m=>({...m,end:time}));change();}}>Definir fim<strong>{measurement.end===null?'Selecionar':studioTime(measurement.end)}</strong></button></div><p className="studio-duration">{interval>0?`${interval.toFixed(2)} s`:'Selecione um fim posterior ao início.'}</p><label className="studio-field">Ciclos completos contados<input type="number" min={0} step={1} value={measurement.cycles} onChange={e=>{setMeasurement(m=>({...m,cycles:e.target.value}));change();}}/></label><label className="studio-field">Distância percorrida (m)<input type="number" min={0} step={.01} value={measurement.distance} onChange={e=>{setMeasurement(m=>({...m,distance:e.target.value}));change();}}/></label><dl className="studio-calculations"><div><dt>Frequência no trecho</dt><dd>{manualCadence!==null&&manualCadence>=0?`${manualCadence.toFixed(1)} ciclos/min`:'Não calculada'}</dd></div><div><dt>Velocidade no trecho</dt><dd>{manualSpeed!==null?`${manualSpeed.toFixed(2)} m/s`:'Não calculada'}</dd></div></dl><p className="studio-muted">Valores derivados dos instantes, distância e contagem informados pelo treinador. Ângulos desenhados são medidas da imagem em 2D.</p><label className="studio-field">FPS de referência<input type="number" min={1} max={240} value={fps} onChange={e=>setFps(Math.max(1,Math.min(240,Number(e.target.value)||30)))}/></label><p className="studio-muted">O avanço por FPS é aproximado em arquivos com taxa variável.</p>
          {canTrack&&<><label className="studio-pose"><input type="checkbox" checked={showPose} onChange={e=>setShowPose(e.target.checked)}/>Exibir rastreamento disponível</label><TrackAssignmentPanel videoId={videoId} trackIds={analysis?.people?.map(p=>String(p.id))??[]}/></>}
          </>}
          {tab==='Assistente'&&<><h3>Revisão assistida</h3><p className="studio-muted">Consulte os dados processados e acompanhe comentários durante a reprodução.</p>{analysis?<VisionCoachPanel videoId={videoId} hasAnalysis playing={playing} currentTime={time} seek={seek} engine={analysis.engine}/>:<p className="studio-empty">{pending?'O vídeo está sendo processado. A revisão manual já está disponível.':'Não há análise automática disponível para este vídeo.'}</p>}</>}
        </div>
      </aside></div>
      </>}
<footer className="studio-footer"><div role="status" className={error?'studio-error':''}>{error||status||(dirty?'Alterações aguardando salvamento.':'Desenhos, observações e voz no mesmo vídeo.')}</div><button className="studio-done" disabled={busy||recording} onClick={close}><Check size={16}/>Fechar</button><button className="studio-save" disabled={loading||!record||(!dirty&&record?.status==='reviewed')||busy||recording} onClick={()=>void save()}><Save size={17}/>{busy?'Salvando…':'Salvar revisão'}</button></footer>
    </div>
  </ModalShell>;
}
