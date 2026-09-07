"""Métricas de desempenho por atleta a partir da trajetória rastreada."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .calibration import Calibration, apply_homography
from .strokes import StrokeStats

REFERENCE_KEYPOINTS = (11, 12, 0)  # quadril médio; nariz como alternativa


@dataclass(frozen=True)
class TrackMetrics:
    duration_seconds: float
    distance: float
    avg_speed: float
    max_speed: float
    mean_motion: float
    peak_motion: float
    steadiness: float
    strokes: int
    stroke_rate: float
    rhythm_consistency: float
    distance_per_stroke: float
    units: str
    coverage: float


def clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def moving_median(values: np.ndarray, window: int = 5) -> np.ndarray:
    if values.size == 0:
        return values
    half = window // 2
    padded = np.pad(values, half, mode="edge")
    return np.array([float(np.median(padded[index : index + window])) for index in range(values.size)])


def moving_average(values: np.ndarray, bucket: int) -> np.ndarray:
    trimmed = values[: (values.size // bucket) * bucket]
    if trimmed.size == 0:
        return values[::bucket]
    return trimmed.reshape(-1, bucket).mean(axis=1)


def speed_series(points: np.ndarray, times: np.ndarray) -> np.ndarray:
    """Velocidade escalar (unidades por segundo) por diferenças centrais."""
    if points.shape[0] < 2:
        return np.zeros(0)
    velocity = np.linalg.norm(np.gradient(points, times, axis=0), axis=1)
    return moving_median(velocity)


def normalize_motion(speed: np.ndarray) -> np.ndarray:
    """Escala 0-100 pela velocidade: p95 como referência de esforço máximo."""
    if speed.size == 0:
        return speed
    reference = float(np.percentile(speed, 95))
    if reference <= 1e-9:
        return np.zeros_like(speed)
    return np.clip(speed * 100.0 / reference, 0.0, 100.0)


def compute_track_metrics(
    times: np.ndarray,
    points: np.ndarray,
    calibration: Calibration | None,
    stroke_stats: StrokeStats,
    tracked_frames: int,
    pose_frames: int,
) -> TrackMetrics:
    """Pontos em pixels; com calibração, converte para metros antes das métricas."""
    units = "px"
    if calibration is not None and points.size:
        points = apply_homography(calibration.homography, points)
        units = "m"

    duration = float(times[-1] - times[0]) if times.size > 1 else 0.0
    if points.shape[0] >= 2 and duration > 0:
        speed = speed_series(points, times)
        distance = float(np.sum(np.linalg.norm(np.diff(points, axis=0), axis=1)))
        avg_speed = float(np.mean(speed)) if speed.size else 0.0
        max_speed = float(np.percentile(speed, 95)) if speed.size else 0.0
        motion = normalize_motion(speed)
        mean_motion = float(np.mean(motion)) if motion.size else 0.0
        peak_motion = float(np.max(motion)) if motion.size else 0.0
        steadiness = clamp(100.0 * (1.0 - float(np.std(speed)) / avg_speed)) if avg_speed > 1e-9 else 0.0
    else:
        distance = 0.0
        avg_speed = 0.0
        max_speed = 0.0
        mean_motion = 0.0
        peak_motion = 0.0
        steadiness = 0.0

    # Distância por ciclo exige cadência medida (>= 2 intervalos válidos); senão fica 0 e a UI mostra "—".
    distance_per_stroke = round(distance / stroke_stats.count, 2) if stroke_stats.count >= 2 and stroke_stats.rate_per_minute > 0 else 0.0
    return TrackMetrics(
        duration_seconds=round(duration, 2),
        distance=round(distance, 2),
        avg_speed=round(avg_speed, 3),
        max_speed=round(max_speed, 3),
        mean_motion=round(mean_motion, 1),
        peak_motion=round(peak_motion, 1),
        steadiness=round(steadiness, 1),
        strokes=stroke_stats.count,
        stroke_rate=round(stroke_stats.rate_per_minute, 1),
        rhythm_consistency=round(stroke_stats.consistency, 1),
        distance_per_stroke=distance_per_stroke,
        units=units,
        coverage=round(100.0 * pose_frames / tracked_frames, 1) if tracked_frames else 0.0,
    )


def motion_timeline(
    times: np.ndarray,
    points: np.ndarray,
    calibration: Calibration | None,
    max_points: int = 600,
) -> list[dict]:
    """Série temporal (tempo, movimento 0-100) para sincronizar com o player."""
    if points.size == 0:
        return []
    if calibration is not None:
        points = apply_homography(calibration.homography, points)
    speed = speed_series(points, times)
    motion = normalize_motion(speed)
    if motion.size > max_points:
        bucket = int(np.ceil(motion.size / max_points))
        times = times[::bucket]
        motion = moving_average(motion, bucket)
    samples = []
    for time, value in zip(times, motion):
        if np.isfinite(value):
            samples.append({"time": round(float(time), 2), "motion": round(float(value))})
    return samples
