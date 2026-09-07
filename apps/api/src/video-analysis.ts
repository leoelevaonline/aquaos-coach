import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";

const execute = promisify(execFile);
const executable = ffmpegPath as unknown as string | null;

export type AnalysisProgress = (progress: number, stage: string) => void | Promise<void>;

type ProbeOutput = {
  streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[];
  format?: { duration?: string; size?: string; bit_rate?: string };
};

function ratio(value = "0/1") {
  const [a, b] = value.split("/").map(Number);
  return b ? a / b : a;
}

async function probeDuration(filePath: string) {
  const { stdout } = await execute(ffprobe.path, ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath], { maxBuffer: 10 * 1024 * 1024 });
  return Number((JSON.parse(stdout) as ProbeOutput).format?.duration ?? 0);
}

/** Quadro de referência em ~45% do vídeo, escalado para até 960 px de largura. */
export async function generateThumbnail(filePath: string, thumbnailPath: string, durationSeconds?: number) {
  if (!executable) throw new Error("FFmpeg não está disponível neste ambiente.");
  const duration = durationSeconds ?? await probeDuration(filePath);
  await execute(executable, ["-y", "-ss", String(Math.max(.5, duration * .45)), "-i", filePath, "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", thumbnailPath], { maxBuffer: 10 * 1024 * 1024 });
}

export async function analyzeVideo(filePath: string, thumbnailPath?: string, onProgress?: AnalysisProgress) {
  if (!executable) throw new Error("FFmpeg não está disponível neste ambiente.");
  await onProgress?.(5, "Lendo metadados do vídeo");
  const { stdout: probeText } = await execute(ffprobe.path, ["-v", "error", "-show_entries", "format=duration,size,bit_rate:stream=codec_type,width,height,r_frame_rate", "-of", "json", filePath], { maxBuffer: 10 * 1024 * 1024 });
  const probe = JSON.parse(probeText) as ProbeOutput;
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const duration = Number(probe.format?.duration ?? 0);

  await onProgress?.(18, "Extraindo movimento quadro a quadro");
  const { stderr } = await execute(executable, ["-hide_banner", "-i", filePath, "-an", "-vf", "fps=8,tblend=all_mode=difference,signalstats,metadata=print", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"], { maxBuffer: 30 * 1024 * 1024 });
  const lines = stderr.split(/\r?\n/);
  const raw: { time: number; value: number }[] = [];
  let currentTime = 0;
  for (const line of lines) {
    const time = line.match(/pts_time:([\d.]+)/)?.[1];
    if (time) currentTime = Number(time);
    const motion = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/)?.[1];
    if (motion) raw.push({ time: currentTime, value: Number(motion) });
  }
  const maximum = Math.max(...raw.map((sample) => sample.value), 1);
  const minimum = Math.min(...raw.map((sample) => sample.value), 0);
  const timeline = raw.map((sample, index) => {
    const neighbors = raw.slice(Math.max(0, index - 2), index + 3);
    const smoothed = neighbors.reduce((sum, entry) => sum + entry.value, 0) / Math.max(neighbors.length, 1);
    return { time: Math.round(sample.time * 1000) / 1000, motion: Math.round(((smoothed - minimum) / Math.max(maximum - minimum, 1)) * 100) };
  });
  const average = timeline.reduce((sum, sample) => sum + sample.motion, 0) / Math.max(timeline.length, 1);
  const peaks: typeof timeline = [];
  for (let index = 1; index < timeline.length - 1; index += 1) {
    const item = timeline[index];
    if (item.motion > Math.max(average * 1.22, 32) && item.motion >= timeline[index - 1].motion && item.motion > timeline[index + 1].motion && (!peaks.length || item.time - peaks[peaks.length - 1].time >= .45)) peaks.push(item);
  }
  const intervals = peaks.slice(1).map((peak, index) => peak.time - peaks[index].time).filter((value) => value > .3 && value < 3);
  const intervalAverage = intervals.reduce((sum, value) => sum + value, 0) / Math.max(intervals.length, 1);
  const deviation = Math.sqrt(intervals.reduce((sum, value) => sum + (value - intervalAverage) ** 2, 0) / Math.max(intervals.length, 1));
  const cadence = intervalAverage ? Math.round(60 / intervalAverage) : 0;
  const consistency = Math.max(0, Math.min(100, Math.round(100 - (deviation / Math.max(intervalAverage, .01)) * 100)));
  const events = peaks.map((peak, index) => ({
    id: `motion-${index + 1}`,
    time: peak.time,
    category: "motion-peak",
    label: `Pico de movimento ${index + 1}`,
    confidence: Math.min(98, Math.max(55, Math.round(55 + peak.motion * .43))),
  }));

  await onProgress?.(78, "Calculando periodicidade do movimento");
  if (thumbnailPath) {
    await onProgress?.(88, "Gerando quadro de referência");
    await generateThumbnail(filePath, thumbnailPath, duration);
  }
  await onProgress?.(100, "Análise concluída");

  // Sem detecção de atletas, o AquaMotion mede apenas movimento global do
  // quadro: não há identidade, braçada, velocidade nem fases - e o contrato
  // declara isso em vez de preencher com valores derivados.
  return {
    engine: "AquaMotion",
    engineVersion: "1.1-beta",
    methodology: "Diferença temporal entre quadros a 8 Hz (movimento global da cena). Não identifica atletas nem braçadas; a periodicidade do movimento é um indicador de apoio para revisão, não uma medição de cadência.",
    analyzedAt: new Date().toISOString(),
    metadata: { durationSeconds: duration, width: video?.width ?? 0, height: video?.height ?? 0, fps: Math.round(ratio(video?.r_frame_rate) * 100) / 100, sizeBytes: Number(probe.format?.size ?? 0), bitrate: Number(probe.format?.bit_rate ?? 0), persons: 0, capabilities: { athletes: false, strokes: false, speed: false, pose: false } },
    metrics: { detectedCycles: peaks.length, estimatedCadence: cadence, rhythmConsistency: consistency, meanMotion: Math.round(average), peakMotion: Math.max(...timeline.map((sample) => sample.motion), 0) },
    timeline,
    events: events.sort((a, b) => a.time - b.time),
  };
}
