"""Métricas de desempenho por atleta a partir da trajetória rastreada."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .calibration import Calibration, apply_homography
from .strokes import StrokeStats, valid_stroke_intervals

REFERENCE_KEYPOINTS = (11, 12, 0)  # quadril médio; nariz como alternativa
MAX_OBSERVED_GAP_SECONDS = 0.75


@dataclass(frozen=True)
class TrackMetrics:
    duration_seconds: float
    observed_duration_seconds: float
    observed_segments: int
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


def split_observed_segments(
    times: np.ndarray,
    values: np.ndarray,
    max_gap_seconds: float = MAX_OBSERVED_GAP_SECONDS,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Separa amostras contíguas sem atravessar NaN nem lacunas temporais."""
    if times.size != values.shape[0]:
        raise ValueError("Tempos e valores devem ter o mesmo tamanho.")
    finite = np.isfinite(times)
    if values.ndim == 1:
        finite &= np.isfinite(values)
    else:
        finite &= np.all(np.isfinite(values), axis=tuple(range(1, values.ndim)))

    segments: list[tuple[np.ndarray, np.ndarray]] = []
    start: int | None = None
    for index, valid in enumerate(finite):
        discontinuity = start is not None and index > 0 and times[index] - times[index - 1] > max_gap_seconds
        if not valid or discontinuity:
            if start is not None and index > start:
                segments.append((times[start:index], values[start:index]))
            start = index if valid else None
        elif start is None:
            start = index
    if start is not None:
        segments.append((times[start:], values[start:]))
    return segments


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
    distance_per_stroke: float | None = None,
    max_gap_seconds: float = MAX_OBSERVED_GAP_SECONDS,
) -> TrackMetrics:
    """Pontos em pixels; com calibração, converte para metros antes das métricas."""
    units = "px"
    if calibration is not None and points.size:
        points = apply_homography(calibration.homography, points)
        units = "m"

    segments = split_observed_segments(times, points, max_gap_seconds)
    finite_times = times[np.isfinite(times)]
    duration = float(finite_times[-1] - finite_times[0]) if finite_times.size > 1 else 0.0
    observed_duration = sum(float(segment_times[-1] - segment_times[0]) for segment_times, _ in segments if segment_times.size > 1)
    distances = [
        float(np.sum(np.linalg.norm(np.diff(segment_points, axis=0), axis=1)))
        for _, segment_points in segments
        if segment_points.shape[0] >= 2
    ]
    speed_parts = [
        speed_series(segment_points, segment_times)
        for segment_times, segment_points in segments
        if segment_points.shape[0] >= 2
    ]
    speed = np.concatenate(speed_parts) if speed_parts else np.zeros(0)
    distance = sum(distances)
    if speed.size and observed_duration > 0:
        avg_speed = distance / observed_duration
        max_speed = float(np.max(speed))
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

    if distance_per_stroke is None:
        distance_per_stroke = distance / stroke_stats.count if len(segments) == 1 and stroke_stats.rate_per_minute > 0 else 0.0
    return TrackMetrics(
        duration_seconds=round(duration, 2),
        observed_duration_seconds=round(observed_duration, 2),
        observed_segments=len(segments),
        distance=round(distance, 2),
        avg_speed=round(avg_speed, 3),
        max_speed=round(max_speed, 3),
        mean_motion=round(mean_motion, 1),
        peak_motion=round(peak_motion, 1),
        steadiness=round(steadiness, 1),
        strokes=stroke_stats.count,
        stroke_rate=round(stroke_stats.rate_per_minute, 1),
        rhythm_consistency=round(stroke_stats.consistency, 1),
        distance_per_stroke=round(distance_per_stroke, 2),
        units=units,
        coverage=round(100.0 * pose_frames / tracked_frames, 1) if tracked_frames else 0.0,
    )


def motion_timeline(
    times: np.ndarray,
    points: np.ndarray,
    calibration: Calibration | None,
    max_points: int = 600,
    max_gap_seconds: float = MAX_OBSERVED_GAP_SECONDS,
) -> list[dict]:
    """Série temporal (tempo, movimento 0-100) para sincronizar com o player."""
    if points.size == 0:
        return []
    if calibration is not None:
        points = apply_homography(calibration.homography, points)
    segments = split_observed_segments(times, points, max_gap_seconds)
    speed_parts = [speed_series(segment_points, segment_times) for segment_times, segment_points in segments if segment_times.size >= 2]
    time_parts = [segment_times for segment_times, _ in segments if segment_times.size >= 2]
    if not speed_parts:
        return []
    speed = np.concatenate(speed_parts)
    times = np.concatenate(time_parts)
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


def distance_per_stroke_from_segments(
    trajectory_segments: list[tuple[np.ndarray, np.ndarray]],
    stroke_segments: list[list[float]],
    calibration: Calibration | None,
) -> float:
    """Distância média apenas nos intervalos de ciclo com trajetória observada."""
    paths = []
    for times, points in trajectory_segments:
        paths.append((times, apply_homography(calibration.homography, points) if calibration is not None else points))

    distances: list[float] = []
    for stroke_times in stroke_segments:
        for start, end in valid_stroke_intervals(stroke_times):
            path = next(((times, points) for times, points in paths if times[0] <= start and times[-1] >= end), None)
            if path is None:
                continue
            times, points = path
            inside = (times > start) & (times < end)
            sample_times = np.concatenate(([start], times[inside], [end]))
            sample_points = np.column_stack([
                np.interp(sample_times, times, points[:, axis]) for axis in range(points.shape[1])
            ])
            distances.append(float(np.sum(np.linalg.norm(np.diff(sample_points, axis=0), axis=1))))
    return float(np.mean(distances)) if distances else 0.0
