"""Testes da detecção de braçadas: contagem, cadência e robustez a ruído."""

from __future__ import annotations

import numpy as np
import pytest

from app.strokes import (
    detect_peaks_hysteresis,
    robust_intervals,
    select_stroke_signal,
    stroke_statistics,
    stroke_statistics_for_segments,
)


def sine(times: np.ndarray, hz: float, amplitude: float = 20.0, noise: float = 0.0, seed: int = 3) -> np.ndarray:
    rng = np.random.default_rng(seed)
    values = amplitude * np.sin(2.0 * np.pi * hz * times)
    if noise:
        values = values + rng.normal(0.0, noise, size=times.size)
    return values


def grid(seconds: float = 10.0, hz: float = 10.0) -> np.ndarray:
    return np.arange(0.0, seconds, 1.0 / hz)


def test_counts_one_stroke_per_cycle():
    times = grid()
    events = detect_peaks_hysteresis(times, sine(times, 1.0))
    assert len(events) == 10
    stats = stroke_statistics(events)
    assert stats.rate_per_minute == pytest.approx(60.0, abs=2.0)
    assert stats.consistency > 95.0


def test_half_frequency_halves_rate():
    times = grid()
    stats = stroke_statistics(detect_peaks_hysteresis(times, sine(times, 0.5)))
    assert stats.count == 5
    assert stats.rate_per_minute == pytest.approx(30.0, abs=2.0)


def test_noisy_signal_still_counts_within_tolerance():
    times = grid()
    events = detect_peaks_hysteresis(times, sine(times, 1.0, noise=4.0))
    assert 9 <= len(events) <= 11
    stats = stroke_statistics(events)
    assert stats.rate_per_minute == pytest.approx(60.0, abs=5.0)


def test_flat_signal_has_no_strokes():
    times = grid()
    assert detect_peaks_hysteresis(times, np.zeros_like(times)) == []
    assert stroke_statistics([]).count == 0


def test_cadence_requires_two_valid_intervals():
    stats = stroke_statistics([0.0, 1.0])
    assert stats.intervals == [1.0]
    assert stats.rate_per_minute == 0.0
    assert stats.consistency == 0.0


def test_statistics_never_join_cycles_across_segments():
    stats = stroke_statistics_for_segments([[0.0, 1.0, 2.0], [10.0, 11.0, 12.0]])
    assert stats.intervals == [1.0, 1.0, 1.0, 1.0]
    assert 8.0 not in stats.intervals
    assert stats.rate_per_minute == pytest.approx(60.0)


def test_robust_intervals_drop_outliers():
    kept = robust_intervals([1.0, 2.0, 3.0, 4.6, 5.6, 6.6])
    assert 4.6 not in kept
    assert kept == pytest.approx([1.0, 1.0, 1.0, 1.0], abs=0.01)


def test_select_stroke_signal_prefers_periodic_series():
    times = grid()
    periodic = (times, sine(times, 1.0))
    noisy = (times, np.random.default_rng(11).normal(0, 5, size=times.size))
    candidates = {
        (9, 1): periodic,   # punho esq., eixo y
        (15, 0): noisy,     # tornozelo esq., eixo x
    }
    signal = select_stroke_signal(candidates)
    assert signal is not None
    assert (signal.keypoint, signal.axis) == (9, 1)
    assert signal.period == pytest.approx(1.0, abs=0.15)


def test_select_stroke_signal_requires_minimum_score():
    times = grid()
    noise = (times, np.random.default_rng(5).normal(0, 3, size=times.size))
    assert select_stroke_signal({(9, 1): noise}) is None
