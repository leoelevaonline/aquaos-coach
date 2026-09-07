import { describe, expect, it, vi } from "vitest";
import { COCO_CONNECTIONS, MAX_HOLD_SECONDS, TRACK_COLORS, drawTrackedSkeleton, poseAtTime, trackColor, type TrackedKeyframe } from "../pose/server-track";

const kpts = (x: number, y: number, score = 0.9) => Array.from({ length: 17 }, () => [x, y, score] as [number, number, number]);

const keyframes: TrackedKeyframe[] = [
  { t: 0, persons: [{ id: 7, kpts: kpts(100, 50, 0.9) }] },
  { t: 1, persons: [{ id: 7, kpts: kpts(200, 90, 0.8) }] },
];

describe("poseAtTime", () => {
  it("interpola linearmente entre keyframes do mesmo atleta", () => {
    const persons = poseAtTime(keyframes, 0.5);
    expect(persons).toHaveLength(1);
    expect(persons[0].id).toBe(7);
    expect(persons[0].kpts[0][0]).toBe(150);
    expect(persons[0].kpts[0][1]).toBe(70);
    expect(persons[0].kpts[0][2]).toBeCloseTo(0.8, 5);
  });

  it("ancora nos extremos só dentro da tolerância de retenção", () => {
    expect(poseAtTime(keyframes, -0.2)[0].kpts[0][0]).toBe(100);
    expect(poseAtTime(keyframes, 1 + MAX_HOLD_SECONDS)[0].kpts[0][0]).toBe(200);
    // Depois disso, o atleta saiu do rastreio: nenhum esqueleto congelado.
    expect(poseAtTime(keyframes, 1 + MAX_HOLD_SECONDS + 0.1)).toEqual([]);
    expect(poseAtTime(keyframes, 99)).toEqual([]);
  });

  it("não preenche lacunas longas e mostra somente amostras próximas das extremidades", () => {
    const withGap: TrackedKeyframe[] = [
      { t: 0, persons: [{ id: 1, kpts: kpts(10, 10) }, { id: 2, kpts: kpts(50, 10) }] },
      { t: 4, persons: [{ id: 1, kpts: kpts(20, 10) }] },
      { t: 8, persons: [{ id: 1, kpts: kpts(30, 10) }, { id: 2, kpts: kpts(90, 10) }] },
    ];
    expect(poseAtTime(withGap, 2)).toEqual([]);
    expect(poseAtTime(withGap, 6)).toEqual([]);
    // Logo antes da reentrada ele reaparece.
    expect(poseAtTime(withGap, 7.7).map((person) => person.id).sort()).toEqual([1, 2]);
  });

  it("não interpola o mesmo atleta através de uma lacuna longa", () => {
    const withLongGap: TrackedKeyframe[] = [
      { t: 0, persons: [{ id: 1, kpts: kpts(10, 10) }] },
      { t: 10, persons: [{ id: 1, kpts: kpts(90, 10) }] },
    ];
    expect(poseAtTime(withLongGap, 0)[0].kpts[0][0]).toBe(10);
    expect(poseAtTime(withLongGap, 5)).toEqual([]);
    expect(poseAtTime(withLongGap, 10)[0].kpts[0][0]).toBe(90);
  });

  it("mantém o atleta presente em um só lado quando a lacuna é curta", () => {
    const staggered: TrackedKeyframe[] = [
      { t: 0, persons: [{ id: 1, kpts: kpts(10, 10) }] },
      { t: 0.4, persons: [{ id: 1, kpts: kpts(20, 10) }, { id: 2, kpts: kpts(30, 10) }] },
    ];
    expect(poseAtTime(staggered, 0.2).map((person) => person.id).sort()).toEqual([1, 2]);
  });

  it("retorna vazio sem keyframes", () => {
    expect(poseAtTime([], 1)).toEqual([]);
  });

  it("não cria pose quando a janela carregada não contém o instante do player", () => {
    const temporalWindow: TrackedKeyframe[] = [{ t: 20, persons: [{ id: 3, kpts: kpts(30, 30) }] }];
    expect(poseAtTime(temporalWindow, 12)).toEqual([]);
    expect(poseAtTime(temporalWindow, 20)).toHaveLength(1);
  });
});

describe("trackColor", () => {
  it("é estável por identidade, não por ordem de aparição no quadro", () => {
    const ids = [3, 9, 12];
    expect(trackColor(9, ids)).toBe(TRACK_COLORS[1]);
    expect(trackColor(12, ids)).toBe(TRACK_COLORS[2]);
    // Mesmo se só o 12 estiver no quadro, a cor não muda.
    expect(trackColor(12, ids)).toBe(TRACK_COLORS[2]);
  });
});

describe("drawTrackedSkeleton", () => {
  const makeContext = () => {
    const moveTo = vi.fn<(x: number, y: number) => void>();
    const fillText = vi.fn<(text: string, x: number, y: number) => void>();
    const arc = vi.fn<(x: number, y: number, r: number, start: number, end: number) => void>();
    const state = { strokeStyles: [] as string[], alphas: [] as number[] };
    const context = {
      clearRect: vi.fn(), beginPath: vi.fn(), moveTo, lineTo: vi.fn(), stroke: vi.fn(),
      arc, fill: vi.fn(), fillText,
      set lineWidth(value: number) { /* registado só quando relevante */ },
      set strokeStyle(value: string) { state.strokeStyles.push(value); },
      set globalAlpha(value: number) { state.alphas.push(value); },
      set lineCap(value: string) { /* idem */ },
      set fillStyle(value: string) { /* idem */ },
      set font(value: string) { /* idem */ },
    } as unknown as CanvasRenderingContext2D;
    return { context, moveTo, fillText, arc, strokeStyles: state.strokeStyles, alphas: state.alphas };
  };

  it("escala coordenadas do vídeo original para o canvas e ignora keypoints fracos", () => {
    const { context, moveTo, fillText, arc } = makeContext();
    const points = kpts(100, 50, 0.9);
    points[9] = [120, 60, 0.1]; // punho fraco: não desenha
    drawTrackedSkeleton(context, {
      persons: [{ id: 7, kpts: points }],
      width: 500,
      height: 250,
      videoWidth: 1000,
      videoHeight: 500,
    });
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 500, 250);
    expect(moveTo).toHaveBeenCalledWith(50, 25);
    expect(fillText).toHaveBeenCalledWith("A#7", 58, 17);
    expect(moveTo.mock.calls.length).toBe(COCO_CONNECTIONS.length - 1);
    expect(arc).toHaveBeenCalledTimes(16);
  });

  it("não desenha sem dimensões de vídeo", () => {
    const { context, moveTo } = makeContext();
    drawTrackedSkeleton(context, { persons: [{ id: 1, kpts: [[1, 1, 1]] }], width: 10, height: 10, videoWidth: 0, videoHeight: 0 });
    expect(moveTo).not.toHaveBeenCalled();
  });

  it("usa a cor da identidade e esmaece quem não está selecionado", () => {
    const { context, strokeStyles, alphas } = makeContext();
    drawTrackedSkeleton(context, {
      persons: [{ id: 2, kpts: kpts(10, 10) }],
      personIds: [1, 2],
      selectedId: 1,
      width: 100, height: 100, videoWidth: 100, videoHeight: 100,
    });
    expect(strokeStyles).toEqual([TRACK_COLORS[1]]);
    expect(alphas[0]).toBeCloseTo(0.35);
  });
});
