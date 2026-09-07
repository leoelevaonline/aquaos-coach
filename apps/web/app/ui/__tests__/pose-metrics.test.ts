import { describe, expect, it } from "vitest";
import {
  AthleteTracker, PoseTracker, angleAt, balanceScore, cadencePerMinute,
  consistencyScore, detectCycleTimes, type Landmark,
} from "../pose/metrics";

/** Onda senoidal amostrada a `hz` com frequência `frequency` Hz. */
function oscillation(frequency: number, seconds: number, sampleHz: number): Array<{ t: number; v: number }> {
  const samples: Array<{ t: number; v: number }> = [];
  for (let index = 0; index < seconds * sampleHz; index += 1) {
    const t = index / sampleHz;
    samples.push({ t, v: 0.5 + 0.2 * Math.sin(2 * Math.PI * frequency * t) });
  }
  return samples;
}

function syntheticPose(time: number, frequency = 1.2, offsetX = 0): Landmark[] {
  const point = (x: number, y: number): Landmark => ({ x: x + offsetX, y, visibility: 1 });
  const sway = (phase: number) => 0.5 + 0.12 * Math.sin(2 * Math.PI * frequency * time + phase);
  const landmarks: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5 + offsetX, y: 0.5, visibility: 1 }));
  landmarks[11] = point(0.4, 0.4);
  landmarks[12] = point(0.6, 0.4);
  landmarks[13] = point(0.35, 0.5);
  landmarks[14] = point(0.65, 0.5);
  landmarks[15] = point(0.3, sway(0));
  landmarks[16] = point(0.7, sway(Math.PI));
  landmarks[23] = point(0.45, 0.7);
  landmarks[24] = point(0.55, 0.7);
  landmarks[25] = point(0.45, 0.85);
  landmarks[26] = point(0.55, 0.85);
  return landmarks;
}

function cadenceAtPlaybackRate(playbackRate: number): number {
  const tracker = new AthleteTracker();
  const realtimeSampleHz = 20;
  const videoDurationSeconds = 8;
  let metrics = tracker.metrics;
  for (let frame = 0; frame <= videoDurationSeconds * realtimeSampleHz / playbackRate; frame += 1) {
    const videoTime = frame / realtimeSampleHz * playbackRate;
    metrics = tracker.push({ time: videoTime * 1000, landmarks: syntheticPose(videoTime) });
  }
  return metrics.cadence;
}

describe("angleAt", () => {
  it("calcula o ângulo interno no vértice", () => {
    expect(angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(90, 5);
    expect(angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })).toBeCloseTo(180, 5);
  });
});

describe("detectCycleTimes + cadencePerMinute", () => {
  it("encontra um ciclo por período e converte em braçadas por minuto", () => {
    const samples = oscillation(1.2, 8, 30);
    const cycles = detectCycleTimes(samples.map((sample) => sample.t * 1000), samples.map((sample) => sample.v));
    expect(cycles.length).toBeGreaterThanOrEqual(8);
    expect(cycles.length).toBeLessThanOrEqual(11);
    expect(cadencePerMinute(cycles)).toBeGreaterThan(60);
    expect(cadencePerMinute(cycles)).toBeLessThan(84);
  });

  it("ignora ruído abaixo da proeminência mínima", () => {
    const samples = oscillation(1.2, 6, 30).map((sample) => ({ ...sample, v: sample.v + 0.005 * Math.sin(sample.t * 90) }));
    const cycles = detectCycleTimes(samples.map((sample) => sample.t * 1000), samples.map((sample) => sample.v));
    expect(cycles.length).toBeLessThan(12);
  });
});

describe("consistencyScore", () => {
  it("pontua intervalos regulares com 100 e irregulares abaixo", () => {
    const regular = [0, 500, 1000, 1500, 2000];
    const irregular = [0, 380, 1120, 1300, 2210];
    expect(consistencyScore(regular)).toBe(100);
    expect(consistencyScore(irregular)).toBeLessThan(80);
  });
});

describe("balanceScore", () => {
  it("retorna 100 para valores iguais e 0 quando um lado é zero", () => {
    expect(balanceScore(70, 70)).toBe(100);
    expect(balanceScore(0, 90)).toBe(0);
  });
});

describe("AthleteTracker", () => {
  it("deriva cadência próxima da frequência do movimento sintético", () => {
    const tracker = new AthleteTracker();
    const sampleHz = 20;
    let metrics = tracker.metrics;
    for (let index = 0; index < 8 * sampleHz; index += 1) {
      metrics = tracker.push({ time: index / sampleHz * 1000, landmarks: syntheticPose(index / sampleHz) });
    }
    expect(metrics.confidence).toBe(100);
    expect(metrics.cadence).toBeGreaterThan(60);
    expect(metrics.cadence).toBeLessThan(84);
    expect(metrics.symmetry).toBeGreaterThan(70);
  });

  it("mantém métricas zeradas antes da janela mínima de amostras", () => {
    const tracker = new AthleteTracker();
    const metrics = tracker.push({ time: 0, landmarks: syntheticPose(0) });
    expect(metrics.cadence).toBe(0);
  });

  it("mantém a cadência na escala do vídeo em 0,5x, 1x e 2x", () => {
    const cadences = [0.5, 1, 2].map(cadenceAtPlaybackRate);
    cadences.forEach((cadence) => {
      expect(cadence).toBeGreaterThan(60);
      expect(cadence).toBeLessThan(84);
    });
    expect(Math.max(...cadences) - Math.min(...cadences)).toBeLessThan(6);
  });
});

describe("PoseTracker", () => {
  it("mantém a identidade do atleta entre quadros e atribui novos ids a novos corpos", () => {
    const tracker = new PoseTracker();
    const first = tracker.update(0, [syntheticPose(0)]);
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe(0);

    const both = tracker.update(100, [syntheticPose(0.1), syntheticPose(0.1, 1.2, 0.4)]);
    expect(both).toHaveLength(2);
    expect(both.map((athlete) => athlete.id).sort()).toEqual([0, 1]);
  });

  it("descarta trilhas que desaparecem por mais de 1,5 s", () => {
    const tracker = new PoseTracker();
    tracker.update(0, [syntheticPose(0), syntheticPose(0, 1.2, 0.4)]);
    const remaining = tracker.update(2000, [syntheticPose(2)]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(0);
  });
});
