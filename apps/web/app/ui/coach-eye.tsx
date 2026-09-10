"use client";
import { useEffect, useRef, useState } from 'react';
import { apiRequest, mediaUrl, uploadFile } from './api';
import { useCoachRecords } from './coach-data';
import { SectionHead } from './components';

type Point = { x: number; y: number };
type Drawing = { tool: 'line' | 'circle' | 'angle'; points: Point[]; time: number };
type VoiceNote = { url: string; time: number };
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

export function CoachEyeWorkspace() {
  const { data, loading, error } = useCoachRecords(['videos']);
  const [open, setOpen] = useState(false);
  const [id, setId] = useState(''), [comparison, setComparison] = useState('');
  const [rate, setRate] = useState(1), [fps, setFps] = useState(30);
  const [tool, setTool] = useState<Drawing['tool'] | 'play'>('play');
  const [drawings, setDrawings] = useState<Drawing[]>([]), [points, setPoints] = useState<Point[]>([]);
  const [voice, setVoice] = useState<VoiceNote[]>([]);
  const [time, setTime] = useState(0), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false), [dirty, setDirty] = useState(false);
  const left = useRef<HTMLVideoElement>(null), right = useRef<HTMLVideoElement>(null);
  const recorder = useRef<MediaRecorder | null>(null), mounted = useRef(true), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const row = data.videos?.find(v => v.id === id), other = data.videos?.find(v => v.id === comparison);
  useEffect(() => { mounted.current=true; return () => { mounted.current=false; if(timer.current) clearTimeout(timer.current); if(recorder.current?.state === 'recording') recorder.current.stop(); recorder.current?.stream.getTracks().forEach(t => t.stop()); }; }, []);
  useEffect(() => { if(left.current) left.current.playbackRate=rate; if(right.current) right.current.playbackRate=rate; }, [rate, id, comparison, open]);
  async function choose(next: string) {
    if(dirty && !window.confirm('Descartar alterações de revisão não salvas?')) return;
    setMessage(''); setBusy(true);
    try {
      const record = await apiRequest<{ coachReview?: { drawings?: Drawing[]; voice?: VoiceNote[] }; analysis?: { metadata?: { fps?: number } } }>(`/api/v1/manage/videos/${next}`);
      setId(next); setDrawings(record.coachReview?.drawings ?? []); setVoice(record.coachReview?.voice ?? []); setPoints([]); setTime(0); setDirty(false); setFps(record.analysis?.metadata?.fps ?? 30);
    } catch(e) { setMessage(String(e)); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setMessage('');
    try { await apiRequest(`/api/v1/manage/videos/${id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ coachReview: { version: 1, drawings, voice }, sourceReview: 'Revisão técnica manual' }) }); setDirty(false); setMessage('Desenhos e comentários salvos no vídeo.'); }
    catch(e) { setMessage(String(e)); } finally { setBusy(false); }
  }
  async function recordVoice() {
    if(recording) { recorder.current?.stop(); return; }
    setMessage(''); setBusy(true);
    let capturedStream: MediaStream | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      capturedStream = stream;
      if(!mounted.current) { stream.getTracks().forEach(t => t.stop()); return; }
      const media = new MediaRecorder(stream), chunks: BlobPart[] = [];
      const at = left.current?.currentTime ?? 0;
      recorder.current=media;
      media.ondataavailable = e => chunks.push(e.data);
      media.onstop = async () => {
        stream.getTracks().forEach(t => t.stop()); if(timer.current) clearTimeout(timer.current);
        if(!mounted.current) return;
        setRecording(false); setBusy(true);
        try {
          const file=await toWav(new Blob(chunks,{type:media.mimeType}));
          const result=await uploadFile(file,'documents',{ title:'Comentário de revisão de vídeo', referenceId:id });
          if(mounted.current) { setVoice(v => [...v,{url:String(result.url),time:at}]); setDirty(true); }
        } catch(e) { if(mounted.current) setMessage(String(e)); } finally { if(mounted.current) setBusy(false); }
      };
      media.start(); setRecording(true); setBusy(false); timer.current=setTimeout(() => { if(media.state==='recording')media.stop(); },120000);
    } catch(e) { capturedStream?.getTracks().forEach(t => t.stop()); if(mounted.current) { setBusy(false); setMessage(`Não foi possível gravar: ${String(e)}`); } }
  }
  function frame(direction: number) {
    [left.current,right.current].forEach(video => { if(video) { video.pause(); video.currentTime=Math.max(0,Math.min(Number.isFinite(video.duration)?video.duration:Infinity,video.currentTime+direction/fps)); } });
  }
  const selectOptions = (data.videos ?? []).map(v => <option key={v.id} value={v.id}>{String(v.title ?? v.name ?? v.id)}</option>);
  return <section className="card coach-panel"><SectionHead title="Revisão técnica de vídeo" subtitle="Câmera lenta, desenhos, ângulos, voz e comparação lado a lado" action={open?'Recolher':'Abrir ferramentas'} onAction={() => { if(open) { left.current?.pause(); right.current?.pause(); if(recorder.current?.state === "recording") recorder.current.stop(); } setOpen(v => !v); }} />
    {open && <><p className="coach-explanation">Ferramentas próprias inspiradas no fluxo do Coach’s Eye. Ângulos são medidos na imagem 2D, sem inferir biomecânica tridimensional.</p>{(error||message) && <p role="status">{error||message}</p>}{loading && <p>Carregando vídeos…</p>}
    <div className="coach-toolbar"><label className="coach-field">Vídeo principal<select disabled={busy||recording} value={id} onChange={e => { if(e.target.value) void choose(e.target.value); }}><option value="">Selecione um vídeo</option>{selectOptions}</select></label><label className="coach-field">Comparar com<select value={comparison} onChange={e => setComparison(e.target.value)}><option value="">Sem comparação</option>{selectOptions}</select></label></div>
    {row && <><div className={`coach-video-grid ${other ? 'compare' : ''}`}><div className="coach-video-stage"><video ref={left} src={mediaUrl(String(row.url ?? ''))} controls={tool==='play'} playsInline onTimeUpdate={e => setTime(e.currentTarget.currentTime)} onError={() => setMessage('Não foi possível reproduzir o vídeo principal.')} />
    <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className={`coach-drawing ${tool==='play'?'passive':''}`} onPointerDown={e => {
      if(tool==='play') return; left.current?.pause(); const box=e.currentTarget.getBoundingClientRect();
      const point={x:(e.clientX-box.left)/box.width*1000,y:(e.clientY-box.top)/box.height*1000};
      const next=[...points,point]; if(next.length===(tool==='angle'?3:2)){setDrawings(d=>[...d,{tool,points:next,time:left.current?.currentTime??0}]);setPoints([]);setDirty(true);} else setPoints(next);
    }}>{drawings.filter(d=>Math.abs(d.time-time)<0.5).map((d,i)=> <g key={i} stroke="#ffda00" fill="none" strokeWidth="4">{d.tool==='circle'?<ellipse cx={(d.points[0].x+d.points[1].x)/2} cy={(d.points[0].y+d.points[1].y)/2} rx={Math.abs(d.points[1].x-d.points[0].x)/2} ry={Math.abs(d.points[1].y-d.points[0].y)/2}/>:<polyline points={d.points.map(p=>`${p.x},${p.y}`).join(' ')} />}{d.tool==='angle' && <text x={d.points[1].x+12} y={d.points[1].y-12} stroke="none" fill="#ffda00" fontSize="28">{(() => {const ratio=(left.current?.videoWidth||1)/(left.current?.videoHeight||1);const p=d.points.map(p=>({x:p.x*ratio,y:p.y}));return angleDegrees(p[0],p[1],p[2])?.toFixed(1)??'—';})()}°</text>}</g>)}{points.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r="7" fill="#ffda00" />)}</svg></div>{other && <video ref={right} src={mediaUrl(String(other.url ?? ''))} controls playsInline onError={() => setMessage('Não foi possível reproduzir o vídeo comparativo.')} />}</div>
    <div className="coach-toolbar"><button className="secondary-button" onClick={() => void Promise.all([left.current,right.current].map(v=>v?.play())).catch(()=>setMessage('Use os controles do player para iniciar.'))}>Reproduzir ambos</button><button className="secondary-button" onClick={()=>{left.current?.pause();right.current?.pause();}}>Pausar</button><button className="secondary-button" onClick={()=>frame(-1)}>Quadro anterior</button><button className="secondary-button" onClick={()=>frame(1)}>Próximo quadro</button><button className="secondary-button" onClick={()=>{if(left.current&&right.current)right.current.currentTime=left.current.currentTime;}}>Alinhar tempos</button><label className="coach-field">Velocidade<select value={rate} onChange={e=>setRate(Number(e.target.value))}>{[0.1,0.25,0.5,1,1.5,2].map(n=><option key={n} value={n}>{n}×</option>)}</select></label><label className="coach-field">FPS de referência<input type="number" min={1} max={240} value={fps} onChange={e=>setFps(Math.max(1,Math.min(240,Number(e.target.value)||30)))} /></label></div>
    <div className="tab-bar">{(['play','line','circle','angle'] as const).map((t,i)=><button key={t} className={tool===t?'active':''} onClick={()=>{setTool(t);setPoints([]);}}>{['Reprodução','Linha (2 pontos)','Círculo (2 pontos)','Ângulo (3 pontos)'][i]}</button>)}</div><div className="coach-toolbar"><button className="secondary-button" disabled={!drawings.length} onClick={()=>{setDrawings(d=>d.slice(0,-1));setDirty(true);}}>Desfazer desenho</button><button className="secondary-button" disabled={busy} onClick={()=>void recordVoice()}>{recording?'Parar gravação':'Gravar comentário de voz'}</button><button className="primary-button" disabled={busy||recording||!dirty} onClick={()=>void save()}>Salvar revisão</button></div><p className="coach-explanation">Clique na imagem para desenhar. Desenhos ficam ligados ao instante do vídeo. Avanço usa o FPS informado; vídeos com taxa variável podem não corresponder a um quadro exato. Áudio limitado a 2 minutos por comentário.</p>
    {drawings.map((d,i)=><button className="secondary-button" key={i} onClick={()=>{if(left.current)left.current.currentTime=d.time;setTime(d.time);}}>Desenho {i+1} · {d.time.toFixed(2)} s</button>)}{voice.map((v,i)=><div className="coach-toolbar" key={i}><button className="secondary-button" onClick={()=>{if(left.current)left.current.currentTime=v.time;}}>Comentário · {v.time.toFixed(2)} s</button><audio controls src={mediaUrl(v.url)} /><button className="text-button" onClick={()=>{setVoice(rows=>rows.filter((_,index)=>index!==i));setDirty(true);}}>Remover da revisão</button></div>)}</>}
    </>}
  </section>;
}
