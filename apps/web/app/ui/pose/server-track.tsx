"use client";

/**
 * Rastreamento do servidor (AquaVision) desenhado em tempo real sobre o player.
 * Os keyframes vêm da análise persistida (pose RTMO refinada por RTMPose) e o
 * canvas interpola entre amostras sincronizado com o currentTime do vídeo -
 * não há inferência no navegador, só renderização.
 */

import { useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";

export type TrackedKeyframe = { t: number; persons: Array<{ id: number; kpts: Array<[number, number, number]> }> };
export type PoseAtTime = Array<{ id: number; kpts: Array<[number, number, number]> }>;

/** Conexões do esqueleto COCO-17 (índices do RTMO/RTMPose). */
export const COCO_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [0, 2], [1, 3], [2, 4],
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16],
];

export const TRACK_COLORS = ["#22d3ee", "#34d399", "#fbbf24", "#f472b6", "#a78bfa", "#fb923c"];
const KEYPOINT_VISIBLE = 0.3;
/** Sem amostra do atleta por mais que isto, o esqueleto sai da tela em vez de congelar. */
export const MAX_HOLD_SECONDS = 0.5;
/** Lacunas maiores não têm evidência suficiente para interpolar uma pose. */
export const MAX_INTERPOLATION_GAP_SECONDS = 1;

/** Cor estável por identidade de atleta, na ordem em que a análise lista `people`. */
export function trackColor(personId: number, personIds: number[]): string {
  const index = personIds.indexOf(personId);
  return TRACK_COLORS[(index >= 0 ? index : personId) % TRACK_COLORS.length];
}

/**
 * Estado da pose no instante t: interpola linearmente entre keyframes por
 * atleta apenas em trechos contínuos. Em lacunas longas, só mostra amostras
 * próximas às extremidades e nunca inventa uma pose no intervalo sem evidência.
 */
export function poseAtTime(keyframes: TrackedKeyframe[], t: number): PoseAtTime {
  if (!keyframes.length) return [];
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (t <= first.t) return first.t - t <= MAX_HOLD_SECONDS ? first.persons : [];
  if (t >= last.t) return t - last.t <= MAX_HOLD_SECONDS ? last.persons : [];
  let previous = first;
  let next = last;
  for (let index = 1; index < keyframes.length; index += 1) {
    if (keyframes[index].t >= t) {
      next = keyframes[index];
      previous = keyframes[index - 1];
      break;
    }
  }
  const span = next.t - previous.t;
  if (span <= 0) return previous.persons;
  if (span > MAX_INTERPOLATION_GAP_SECONDS) {
    const nearby = new Map<number, PoseAtTime[number]>();
    for (const person of previous.persons) {
      if (t - previous.t <= MAX_HOLD_SECONDS) nearby.set(person.id, person);
    }
    for (const person of next.persons) {
      if (next.t - t <= MAX_HOLD_SECONDS) nearby.set(person.id, person);
    }
    return [...nearby.values()];
  }
  const ratio = (t - previous.t) / span;
  const nextById = new Map(next.persons.map((person) => [person.id, person]));
  const result: PoseAtTime = [];
  for (const person of previous.persons) {
    const match = nextById.get(person.id);
    if (!match) {
      if (t - previous.t <= MAX_HOLD_SECONDS) result.push(person);
      continue;
    }
    nextById.delete(person.id);
    result.push({
      id: person.id,
      kpts: person.kpts.map((point, keypoint) => {
        const target = match.kpts[keypoint];
        if (!target) return point;
        return [
          point[0] + (target[0] - point[0]) * ratio,
          point[1] + (target[1] - point[1]) * ratio,
          Math.min(point[2], target[2]),
        ] as [number, number, number];
      }),
    });
  }
  // Atleta que reaparece no próximo keyframe: entra assim que estiver perto.
  for (const person of nextById.values()) {
    if (next.t - t <= MAX_HOLD_SECONDS) result.push(person);
  }
  return result;
}

/** Desenha os esqueletos rastreados; coordenadas em pixels do vídeo original. */
export function drawTrackedSkeleton(
  context: CanvasRenderingContext2D,
  options: { persons: PoseAtTime; width: number; height: number; videoWidth: number; videoHeight: number; personIds?: number[]; selectedId?: number | null },
): void {
  const { persons, width, height, videoWidth, videoHeight, selectedId = null } = options;
  const personIds = options.personIds ?? persons.map((person) => person.id);
  context.clearRect(0, 0, width, height);
  if (!videoWidth || !videoHeight) return;
  const scaleX = width / videoWidth;
  const scaleY = height / videoHeight;
  persons.forEach((person) => {
    const color = trackColor(person.id, personIds);
    const dimmed = selectedId !== null && selectedId !== person.id;
    const points = person.kpts.map(([x, y]) => ({ x: x * scaleX, y: y * scaleY }));
    const visible = person.kpts.map(([, , score]) => score >= KEYPOINT_VISIBLE);
    context.globalAlpha = dimmed ? 0.35 : 1;
    context.lineWidth = dimmed ? 2 : 3;
    context.strokeStyle = color;
    context.lineCap = "round";
    context.beginPath();
    for (const [from, to] of COCO_CONNECTIONS) {
      if (!visible[from] || !visible[to]) continue;
      context.moveTo(points[from].x, points[from].y);
      context.lineTo(points[to].x, points[to].y);
    }
    context.stroke();
    person.kpts.forEach(([, , score], keypoint) => {
      if (score < KEYPOINT_VISIBLE) return;
      context.beginPath();
      context.arc(points[keypoint].x, points[keypoint].y, 4, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
    });
    const nose = points[0];
    if (nose && visible[0]) {
      context.font = "600 13px system-ui, sans-serif";
      context.fillStyle = color;
      context.fillText(`A#${person.id}`, nose.x + 8, nose.y - 8);
    }
    context.globalAlpha = 1;
  });
}

export function ServerTrackingLayer({
  videoRef,
  active,
  keyframes,
  personIds = [],
  selectedId = null,
  coverageEndsAt = null,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  active: boolean;
  keyframes: TrackedKeyframe[];
  personIds?: number[];
  selectedId?: number | null;
  coverageEndsAt?: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visibleRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const render = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas) {
        if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
          canvas.width = canvas.clientWidth;
          canvas.height = canvas.clientHeight;
        }
        const context = canvas.getContext("2d");
        if (context) {
          const persons = poseAtTime(keyframes, video.currentTime);
          drawTrackedSkeleton(context, {
            persons,
            width: canvas.width,
            height: canvas.height,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            personIds,
            selectedId,
          });
          if (visibleRef.current) {
            const beyondCoverage = coverageEndsAt !== null && video.currentTime > coverageEndsAt;
            visibleRef.current.textContent = beyondCoverage
              ? `sem pose sincronizada após ${coverageEndsAt.toFixed(0)} s`
              : `${persons.length} de ${personIds.length || persons.length} no quadro`;
          }
        }
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      const canvas = canvasRef.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [active, keyframes, videoRef, personIds, selectedId, coverageEndsAt]);

  if (!active) return null;
  return <>
    <canvas ref={canvasRef} className="pose-tracking-canvas" />
    <span className="pose-tracking-chip"><Sparkles size={12} />AquaVision · <span ref={visibleRef} /></span>
  </>;
}
