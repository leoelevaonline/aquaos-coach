"""Testes das métricas: velocidade, distância, normalização e calibração."""

from __future__ import annotations

import numpy as np
import pytest

from app.calibration import CalibrationPoint, build_calibration
from app.metrics import compute_track_metrics, distance_per_stroke_from_segments, motion_timeline, normalize_motion
from app.strokes import StrokeStats

SQUARE = [
    CalibrationPoint(image=(0.0, 0.0), world=(0.0, 0.0)),
    CalibrationPoint(image=(400.0, 0.0), world=(25.0, 0.0)),
    CalibrationPoint(image=(400.0, 200.0), world=(25.0, 12.5)),
    CalibrationPoint(image=(0.0, 200.0), world=(0.0, 12.5)),
]


def constant_speed_track(seconds: float = 10.0, hz: float = 10.0, speed: float = 10.0):
    times = np.arange(0.0, seconds, 1.0 / hz)
    points = np.stack([times * speed, np.full_like(times, 5.0)], axis=1)
    return times, points


def test_constant_speed_metrics():
    times, points = constant_speed_track()
    metrics = compute_track_metrics(
        times, points, calibration=None, stroke_stats=StrokeStats(10, 60.0, 95.0, []), tracked_frames=100, pose_frames=100
    )
    assert metrics.avg_speed == pytest.approx(10.0, abs=0.5)
    assert metrics.distance == pytest.approx(100.0, abs=1.0)
    assert metrics.steadiness > 95.0
    assert metrics.distance_per_stroke == pytest.approx(10.0, abs=0.2)
    assert not hasattr(metrics, "technical_index")
    assert metrics.units == "px"


def test_calibration_converts_units_to_meters():
    times, points = constant_speed_track(speed=100.0)  # 100 px/s -> 6.25 m/s
    calibration = build_calibration(SQUARE)
    assert calibration is not None
    metrics = compute_track_metrics(
        times, points, calibration=calibration, stroke_stats=StrokeStats(0, 0.0, 0.0, []), tracked_frames=100, pose_frames=100
    )
    assert metrics.units == "m"
    assert metrics.avg_speed == pytest.approx(6.25, abs=0.3)
    assert metrics.distance == pytest.approx(62.5, abs=1.0)


def test_stationary_track_degenerates_gracefully():
    times = np.arange(0.0, 5.0, 0.1)
    points = np.stack([np.full_like(times, 42.0), np.full_like(times, 7.0)], axis=1)
    metrics = compute_track_metrics(
        times, points, calibration=None, stroke_stats=StrokeStats(0, 0.0, 0.0, []), tracked_frames=50, pose_frames=50
    )
    assert metrics.avg_speed == 0.0
    assert metrics.distance == 0.0
    assert metrics.mean_motion == 0.0
    assert metrics.steadiness == 0.0


def test_distance_per_stroke_requires_measured_cadence():
    times, points = constant_speed_track()
    single = compute_track_metrics(
        times, points, calibration=None, stroke_stats=StrokeStats(1, 0.0, 0.0, []), tracked_frames=100, pose_frames=100
    )
    assert single.distance_per_stroke == 0.0


def test_metrics_do_not_cross_unobserved_gaps():
    times = np.array([0.0, 0.1, 0.2, 10.0, 10.1, 10.2])
    points = np.array([[0.0, 0.0], [10.0, 0.0], [20.0, 0.0], [1000.0, 0.0], [1010.0, 0.0], [1020.0, 0.0]])
    metrics = compute_track_metrics(
        times, points, calibration=None, stroke_stats=StrokeStats(0, 0.0, 0.0, []), tracked_frames=120, pose_frames=6
    )
    assert metrics.duration_seconds == 10.2
    assert metrics.observed_duration_seconds == 0.4
    assert metrics.observed_segments == 2
    assert metrics.distance == 40.0
    assert metrics.avg_speed == pytest.approx(100.0)
    assert metrics.max_speed == pytest.approx(100.0)


def test_distance_per_stroke_uses_only_cycle_intervals_with_observed_path():
    trajectories = [
        (np.array([0.0, 1.0, 2.0]), np.array([[0.0, 0.0], [10.0, 0.0], [20.0, 0.0]])),
        (np.array([10.0, 11.0, 12.0]), np.array([[1000.0, 0.0], [1010.0, 0.0], [1020.0, 0.0]])),
    ]
    result = distance_per_stroke_from_segments(trajectories, [[0.0, 1.0, 2.0], [10.0, 11.0, 12.0]], None)
    assert result == pytest.approx(10.0)


def test_normalize_motion_uses_p95_as_ceiling():
    speed = np.linspace(0.0, 200.0, 200)
    motion = normalize_motion(speed)
    assert motion.max() <= 100.0
    assert motion.max() >= 99.0


def test_motion_timeline_shape_and_bounds():
    times, points = constant_speed_track()
    timeline = motion_timeline(times, points, None)
    assert 50 <= len(timeline) <= 600
    assert all(0 <= sample["motion"] <= 100 for sample in timeline)
    assert timeline[0]["time"] == pytest.approx(0.0, abs=0.11)
    assert all(timeline[index]["time"] < timeline[index + 1]["time"] for index in range(len(timeline) - 1))


def test_motion_timeline_downsamples_long_series():
    times = np.arange(0.0, 300.0, 0.1)
    points = np.stack([times * 5.0, np.zeros_like(times)], axis=1)
    timeline = motion_timeline(times, points, None, max_points=600)
    assert len(timeline) <= 600
