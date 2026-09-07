"""Detecção de ciclos de braçada a partir da oscilação periódica dos keypoints.

Estratégia agnóstica à câmera: avalia sinais candidatos (punhos, tornozelos,
nariz, cotovelos em x e y), escolhe o de maior periodicidade por autocorrelação
dentro da faixa fisiológica de braçadas e conta picos com histerese (Schmitt),
o que evita dupla contagem em ciclos ruidosos.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

MIN_STROKE_PERIOD = 0.4  # s - limite fisiológico inferior (~150 ciclos/min)
MAX_STROKE_PERIOD = 3.0  # s - braçada longa de águas abertas
MIN_STROKE_INTERVAL = 0.35  # s - intervalo mínimo aceito entre picos
STROKE_SIGNAL_MIN_SCORE = 0.35  # autocorrelação mínima para aceitar o sinal
MIN_CADENCE_INTERVALS = 2
MIN_RHYTHM_INTERVALS = 3

# Índices COCO-17: 0 nariz, 5/6 ombros, 7/8 cotovelos, 9/10 punhos,
# 11/12 quadris, 13/14 joelhos, 15/16 tornozelos.
CANDIDATE_KEYPOINTS = (9, 10, 15, 16, 0, 7, 8)
KEYPOINT_NAMES = {
    0: "nariz", 5: "ombro esq.", 6: "ombro dir.", 7: "cotovelo esq.", 8: "cotovelo dir.",
    9: "punho esq.", 10: "punho dir.", 11: "quadril esq.", 12: "quadril dir.",
    13: "joelho esq.", 14: "joelho dir.", 15: "tornozelo esq.", 16: "tornozelo dir.",
}
AXIS_NAMES = ("x", "y")


@dataclass(frozen=True)
class StrokeSignal:
    keypoint: int
    axis: int
    score: float
    period: float
    label: str


@dataclass(frozen=True)
class StrokeStats:
    count: int
    rate_per_minute: float
    consistency: float  # 0-100
    intervals: list[float]


def _demean(values: np.ndarray) -> np.ndarray:
    return values - values.mean()


def autocorrelation_periodicity(times: np.ndarray, values: np.ndarray) -> tuple[float, float]:
    """Melhor autocorrelação e período dominante dentro da faixa plausível."""
    values = _demean(values)
    if values.size < 8 or float(np.std(values)) < 1e-9:
        return 0.0, 0.0
    span = float(times[-1] - times[0])
    if span <= 0:
        return 0.0, 0.0
    dt = float(np.median(np.diff(times)))
    min_lag = max(1, int(MIN_STROKE_PERIOD / dt))
    max_lag = min(values.size - 4, int(MAX_STROKE_PERIOD / dt))
    best_score, best_period = 0.0, 0.0
    for lag in range(min_lag, max_lag + 1):
        left, right = values[:-lag], values[lag:]
        overlap = float(np.sqrt(np.dot(left, left) * np.dot(right, right)))
        if overlap <= 1e-12:
            continue
        score = float(np.dot(left, right) / overlap)
        period = lag * dt
        if span < 2 * period:
            break  # menos de dois ciclos completos: sem evidência de periodicidade
        # Empates numéricos em harmônicos (r=1.0 em múltiplos do período) ficam
        # com o menor lag: queremos o período fundamental da braçada.
        if score > best_score * (1.0 + 1e-3):
            best_score, best_period = score, period
    return best_score, best_period


def detect_peaks_hysteresis(times: np.ndarray, values: np.ndarray, high_margin: float = 0.6) -> list[float]:
    """Cruzas acima de media + margin*desvio que só rearmanam após cair abaixo da média."""
    if values.size < 4:
        return []
    mean = float(values.mean())
    std = float(values.std())
    if std < 1e-9:
        return []
    high = mean + high_margin * std
    events: list[float] = []
    armed = True
    for index in range(1, len(values)):
        previous, current = values[index - 1], values[index]
        if armed and previous <= high < current:
            crossing = times[index - 1] + (high - previous) / (current - previous) * (times[index] - times[index - 1])
            if not events or crossing - events[-1] >= MIN_STROKE_INTERVAL:
                events.append(float(crossing))
            armed = False
        elif not armed and current < mean:
            armed = True
    return events


def valid_stroke_intervals(stroke_times: list[float]) -> list[tuple[float, float]]:
    """Pares consecutivos de ciclos filtrados sem criar intervalos implícitos."""
    if len(stroke_times) < 2:
        return []
    times = np.asarray(stroke_times, dtype=np.float64)
    starts, ends = times[:-1], times[1:]
    intervals = ends - starts
    valid = (intervals >= MIN_STROKE_INTERVAL) & (intervals <= MAX_STROKE_PERIOD * 1.5)
    starts, ends, intervals = starts[valid], ends[valid], intervals[valid]
    if intervals.size < 2:
        return [(float(start), float(end)) for start, end in zip(starts, ends)]
    median = float(np.median(intervals))
    mad = float(np.median(np.abs(intervals - median))) * 1.4826
    # Séries quase regulares têm MAD ~ 0; usa tolerância proporcional para ainda cortar outliers.
    tolerance = 2.5 * mad if mad > 1e-9 else 0.25 * median
    if tolerance > 0:
        valid = np.abs(intervals - median) <= tolerance
        starts, ends = starts[valid], ends[valid]
    return [(float(start), float(end)) for start, end in zip(starts, ends)]


def robust_intervals(stroke_times: list[float]) -> list[float]:
    """Intervalos entre ciclos, filtrados por MAD para descartar outliers."""
    return [end - start for start, end in valid_stroke_intervals(stroke_times)]


def stroke_statistics(stroke_times: list[float]) -> StrokeStats:
    return stroke_statistics_for_segments([stroke_times])


def stroke_statistics_for_segments(stroke_segments: list[list[float]]) -> StrokeStats:
    """Agrega somente intervalos internos aos trechos observados."""
    intervals = [
        end - start
        for stroke_times in stroke_segments
        for start, end in valid_stroke_intervals(stroke_times)
    ]
    count = sum(len(stroke_times) for stroke_times in stroke_segments)
    rounded = [round(value, 3) for value in intervals]
    if len(intervals) < MIN_CADENCE_INTERVALS:
        return StrokeStats(count=count, rate_per_minute=0.0, consistency=0.0, intervals=rounded)
    mean = float(np.mean(intervals))
    deviation = float(np.std(intervals))
    rate = 60.0 / float(np.median(intervals)) if np.median(intervals) > 0 else 0.0
    consistency = (
        max(0.0, min(100.0, 100.0 * (1.0 - deviation / mean)))
        if len(intervals) >= MIN_RHYTHM_INTERVALS and mean > 0
        else 0.0
    )
    return StrokeStats(
        count=count,
        rate_per_minute=rate,
        consistency=consistency,
        intervals=rounded,
    )


def select_stroke_signal(series_by_keypoint: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]]) -> StrokeSignal | None:
    """Escolhe o sinal candidato com maior periodicidade dentro da faixa de braçadas."""
    best: StrokeSignal | None = None
    for (keypoint, axis), (times, values) in series_by_keypoint.items():
        if values.size < 8:
            continue
        score, period = autocorrelation_periodicity(times, values)
        if score < STROKE_SIGNAL_MIN_SCORE or period <= 0:
            continue
        label = f"{KEYPOINT_NAMES.get(keypoint, keypoint)} ({AXIS_NAMES[axis]})"
        if best is None or score > best.score:
            best = StrokeSignal(keypoint=keypoint, axis=axis, score=score, period=period, label=label)
    return best
