import { describe, expect, it } from "vitest";
import { eventGlyph, metricDisplay } from "../modals";

const person = {
  id: 7, firstSeen: 0, lastSeen: 9.9, durationSeconds: 9.9, strokes: 9, strokeRate: 58, rhythmConsistency: 91,
  avgSpeed: 26.5, maxSpeed: 54.8, distance: 262, distancePerStroke: 29.1, units: "px", meanConfidence: 0.81, coverage: 87.5,
  validity: { strokes: "measured", strokeRate: "measured", rhythmConsistency: "measured", avgSpeed: "uncalibrated", maxSpeed: "uncalibrated", distance: "uncalibrated", distancePerStroke: "uncalibrated" } as const,
};

describe("metricDisplay", () => {
  it("mostra a medição com unidade quando medida", () => {
    expect(metricDisplay(person, "strokeRate", person.strokeRate, "/min")).toEqual({ value: "58/min", note: null });
  });

  it("marca pixels como sem calibração em vez de fingir metros", () => {
    expect(metricDisplay(person, "avgSpeed", person.avgSpeed, " {u}/s")).toEqual({ value: "26.5 px/s", note: "sem calibração" });
  });

  it("expõe o motivo quando a calibração não torna a métrica confiável", () => {
    const unreliable = { ...person, units: "m", validity: { ...person.validity, avgSpeed: "measured" as const }, metricAvailability: { avgSpeed: { available: true, reliable: false, reason: "cobertura da calibração insuficiente" } } };
    expect(metricDisplay(unreliable, "avgSpeed", unreliable.avgSpeed, " {u}/s")).toEqual({ value: "26.5 m/s", note: "cobertura da calibração insuficiente" });
  });

  it("mostra travessão e 'não medido' quando a métrica não existe", () => {
    const unmeasured = { ...person, strokeRate: 0, validity: { ...person.validity, strokeRate: "unavailable" as const } };
    expect(metricDisplay(unmeasured, "strokeRate", 0, "/min")).toEqual({ value: "—", note: "não medido" });
  });

  it("sem estado de validade, zero nunca vira medição", () => {
    const legacy = { ...person, validity: undefined, distancePerStroke: 0 };
    expect(metricDisplay(legacy, "distancePerStroke", 0, " {u}")).toEqual({ value: "—", note: "não medido" });
  });

  it("não trata not_validated como valor apresentável", () => {
    const gated = { ...person, validity: { ...person.validity, strokeRate: "not_validated" as const } };
    expect(metricDisplay(gated, "strokeRate", gated.strokeRate, "/min")).toEqual({ value: "—", note: "não validado" });
  });
});

describe("eventGlyph", () => {
  it("distingue braçada de pico de movimento global", () => {
    expect(eventGlyph({ id: "a", time: 1, category: "stroke", label: "Braçada 1", confidence: 90 })).toBe("B");
    expect(eventGlyph({ id: "b", time: 1, category: "motion-peak", label: "Pico de movimento 1", confidence: 70 })).toBe("M");
    expect(eventGlyph({ id: "c", time: 1, category: "virada", label: "Virada · validação do treinador", confidence: 100 })).toBe("V");
  });
});
