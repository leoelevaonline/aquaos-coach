"""Pipeline AquaVision: decodifica o vídeo, estima pose, rastreia e mede.

Contrato de saída compatível com a análise AquaMotion existente (metrics,
timeline, events) para a UI continuar funcionando, estendido com a lista
`people` (uma entrada por atleta rastreado).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

import cv2
import numpy as np

from .calibration import Calibration, CalibrationPoint, build_calibration
from .errors import NoPeopleDetected
from .metrics import TrackMetrics, compute_track_metrics, motion_timeline
from .smoothing import resample_and_smooth
from .strokes import CANDIDATE_KEYPOINTS, StrokeStats, detect_peaks_hysteresis, select_stroke_signal, stroke_statistics
from .tracker import KEYPOINT_VALID_THRESHOLD, ByteTracker, Detection, Track, TrackSample, bbox_from_keypoints, person_score, stitch_tracks

ProgressCallback = Callable[[float, str], None]
PoseCallable = Callable[..., tuple[np.ndarray, np.ndarray]]

ENGINE_NAME = "AquaVision"
ENGINE_VERSION = "1.0"
METHODOLOGY = (
    "Pose one-stage RTMO (COCO-17) refinada por RTMPose top-down no crop de cada atleta rastreado, "
    "+ rastreio BYTE com filtro de Kalman, costura de fragmentos e suavização zero-fase Savitzky-Golay. "
    "Braçadas por periodicidade dos keypoints; velocidade e distância em pixels ou metros (com calibração). "
    "Métricas objetivas de apoio - a validação técnica permanece com o treinador."
)

# Índices COCO-17 usados como referência de posição do atleta.
HIP_LEFT, HIP_RIGHT, NOSE = 11, 12, 0
KEYFRAME_OUTPUT_HZ = 6.0  # o player interpola; 6 Hz basta e mantém o payload leve
KEYFRAME_OUTPUT_CAP = 600
KEYFRAME_MAX_PERSONS = 6
REFINEMENT_BOX_EXPANSION = 0.25  # margem ao redor da caixa do atleta para o crop
REFINEMENT_MIN_VALID_KEYPOINTS = 8
REFINEMENT_MIN_MEAN_SCORE = 0.5


@dataclass(frozen=True)
class AnalyzeOptions:
    target_fps: float = 12.0
    max_frame_width: int = 960
    min_track_seconds: float = 1.5
    min_pose_frames: int = 10
    rtmo_score_thr: float = 0.25


def _report(on_progress: ProgressCallback | None, value: float, stage: str) -> None:
    if on_progress is not None:
        on_progress(value, stage)


def _video_metadata(capture: cv2.VideoCapture, path: str) -> tuple[float, int, int, float, int]:
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    if fps <= 1.0:
        fps = 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frames / fps if frames else 0.0
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    return fps, width, height, duration, size


def _reference_points(samples: list) -> tuple[np.ndarray, np.ndarray]:
    """Trajetória do atleta: quadril médio, com fallback para nariz e centro da caixa."""
    times: list[float] = []
    points: list[tuple[float, float]] = []
    for sample in samples:
        keypoints, scores = sample.keypoints, sample.keypoint_scores
        hips = [index for index in (HIP_LEFT, HIP_RIGHT) if scores[index] > KEYPOINT_VALID_THRESHOLD]
        if hips:
            x, y = float(keypoints[hips, 0].mean()), float(keypoints[hips, 1].mean())
        elif scores[NOSE] > KEYPOINT_VALID_THRESHOLD:
            x, y = float(keypoints[NOSE, 0]), float(keypoints[NOSE, 1])
        else:
            x = float(sample.bbox[0] + sample.bbox[2]) / 2.0
            y = float(sample.bbox[1] + sample.bbox[3]) / 2.0
        times.append(sample.timestamp)
        points.append((x, y))
    if not times:
        return np.zeros(0), np.zeros((0, 2))
    return np.asarray(times, dtype=np.float64), np.asarray(points, dtype=np.float64)


def _keypoint_series(samples: list, keypoint: int, axis: int) -> tuple[np.ndarray, np.ndarray]:
    """Série (tempo, coordenada) de um keypoint, apenas com amostras válidas."""
    times, values = [], []
    for sample in samples:
        if sample.keypoint_scores[keypoint] > KEYPOINT_VALID_THRESHOLD:
            times.append(sample.timestamp)
            values.append(float(sample.keypoints[keypoint, axis]))
    if len(times) < 2:
        return np.zeros(0), np.zeros(0)
    return np.asarray(times, dtype=np.float64), np.asarray(values, dtype=np.float64)


def _stroke_events(person_id: int, stroke_times: list[float], confidence: float) -> list[dict]:
    safe_confidence = int(round(max(55.0, min(98.0, 40.0 + 60.0 * confidence))))
    return [
        {
            "id": f"stroke-{person_id}-{index + 1}",
            "time": round(float(time), 2),
            "category": "stroke",
            "label": f"Braçada {index + 1} · Atleta #{person_id}",
            "confidence": safe_confidence,
            "personId": person_id,
        }
        for index, time in enumerate(stroke_times)
    ]


def _track_gaps(track: Track, sample_rate: float, min_gap_seconds: float = 0.75) -> list[dict]:
    """Intervalos sem amostra do atleta (submersão, oclusão, saída de quadro)."""
    gaps: list[dict] = []
    threshold = max(min_gap_seconds, 3.0 / sample_rate)
    for previous, current in zip(track.history, track.history[1:]):
        gap = current.timestamp - previous.timestamp
        if gap >= threshold:
            gaps.append({"from": round(previous.timestamp, 2), "to": round(current.timestamp, 2)})
    return gaps


def _metric_validity(metrics: TrackMetrics, stats: StrokeStats, calibrated: bool) -> dict:
    """Estado de validade por métrica: `measured`, `unavailable` ou `uncalibrated`."""
    has_cadence = stats.count >= 2 and stats.rate_per_minute > 0
    distance_state = "measured" if calibrated else "uncalibrated"
    return {
        "strokes": "measured" if stats.count > 0 else "unavailable",
        "strokeRate": "measured" if has_cadence else "unavailable",
        "rhythmConsistency": "measured" if has_cadence and stats.count >= 3 else "unavailable",
        "avgSpeed": distance_state if metrics.duration_seconds > 0 else "unavailable",
        "maxSpeed": distance_state if metrics.duration_seconds > 0 else "unavailable",
        "distance": distance_state if metrics.duration_seconds > 0 else "unavailable",
        "distancePerStroke": distance_state if has_cadence and metrics.distance_per_stroke > 0 else "unavailable",
    }


def _analyze_track(track: Track, calibration: Calibration | None, sample_rate: float) -> dict:
    """Métricas completas de um atleta rastreado (trajetória + braçadas)."""
    pose_samples = track.pose_samples
    all_samples = track.history
    times, points = _reference_points(all_samples)
    if times.size >= 5:
        # Suavização zero-fase na grade regular; os dois eixos compartilham a grade.
        grid, smooth_x = resample_and_smooth(times, points[:, 0], sample_rate)
        _, smooth_y = resample_and_smooth(times, points[:, 1], sample_rate)
        points = np.stack([smooth_x, smooth_y], axis=1)
        keep = np.isfinite(points[:, 0]) & np.isfinite(points[:, 1])
        times, points = grid[keep], points[keep]

    candidates: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}
    for keypoint in CANDIDATE_KEYPOINTS:
        for axis in (0, 1):
            series_times, series_values = _keypoint_series(pose_samples, keypoint, axis)
            if series_times.size >= 8:
                grid, smoothed = resample_and_smooth(series_times, series_values, sample_rate)
                finite = np.isfinite(smoothed)
                if finite.sum() >= 8:
                    candidates[(keypoint, axis)] = (grid[finite], smoothed[finite])

    signal = select_stroke_signal(candidates)
    stroke_times: list[float] = []
    stats = StrokeStats(count=0, rate_per_minute=0.0, consistency=0.0, intervals=[])
    if signal is not None:
        series_times, series_values = candidates[(signal.keypoint, signal.axis)]
        stroke_times = detect_peaks_hysteresis(series_times, series_values)
        stats = stroke_statistics(stroke_times)

    span = all_samples[-1].timestamp - all_samples[0].timestamp
    tracked_frames = max(len(all_samples), int(round(span * sample_rate)) + 1)
    metrics = compute_track_metrics(
        times,
        points,
        calibration=calibration,
        stroke_stats=stats,
        tracked_frames=tracked_frames,
        pose_frames=len(pose_samples),
    )
    return {
        "track": track,
        "metrics": metrics,
        "stats": stats,
        "strokeTimes": [round(float(value), 2) for value in stroke_times],
        "signal": signal.label if signal else None,
        "times": times,
        "points": points,
    }


def _valid_stats(keypoint_scores: np.ndarray) -> tuple[int, float]:
    valid = keypoint_scores[keypoint_scores > KEYPOINT_VALID_THRESHOLD]
    return int(valid.size), float(valid.mean()) if valid.size else 0.0


def _expand_box(bbox: np.ndarray, frame_shape: tuple[int, int], expansion: float) -> list[float]:
    """Caixa ampliada e clamped aos limites do quadro, para o crop de refinamento."""
    height, width = frame_shape[:2]
    box_width = float(bbox[2] - bbox[0])
    box_height = float(bbox[3] - bbox[1])
    x1 = max(0.0, float(bbox[0]) - box_width * expansion)
    y1 = max(0.0, float(bbox[1]) - box_height * expansion)
    x2 = min(float(width), float(bbox[2]) + box_width * expansion)
    y2 = min(float(height), float(bbox[3]) + box_height * expansion)
    return [x1, y1, x2, y2]


def _refine_frame(frame: np.ndarray, tracker: ByteTracker, scale: float, timestamp: float, frame_index: int, refine) -> None:
    """Refina a pose de cada atleta confirmado no crop da própria caixa.

    Tracks pareados ganham keypoints de alta resolução; tracks submersos (sem
    detecção neste quadro) tentam recuperação pela caixa prevista pelo Kalman -
    só cria amostra se o RTMPose encontrar uma pose real no crop.
    """
    confirmed = [track for track in tracker.tracks if track.confirmed]
    if not confirmed:
        return
    boxes_frame = [_expand_box(track.kalman.project() * scale, frame.shape, REFINEMENT_BOX_EXPANSION) for track in confirmed]
    try:
        keypoints, scores = refine(frame, bboxes=boxes_frame)
    except Exception:  # noqa: BLE001 - refinamento nunca pode derrubar a análise
        return
    for track, box_frame, person_keypoints, person_scores in zip(confirmed, boxes_frame, keypoints, scores):
        person_keypoints = np.asarray(person_keypoints, dtype=np.float64).reshape(-1, 2)
        person_scores = np.asarray(person_scores, dtype=np.float64).reshape(-1)
        if person_keypoints.shape[0] < 17:
            continue
        valid_count, mean_score = _valid_stats(person_scores)
        matched = track.history[-1].frame_index == frame_index if track.history else False
        if matched:
            sample = track.history[-1]
            current_valid, current_mean = _valid_stats(sample.keypoint_scores)
            better = valid_count > current_valid or (valid_count == current_valid and mean_score > current_mean)
            if better and valid_count >= REFINEMENT_MIN_VALID_KEYPOINTS:
                sample.keypoints = person_keypoints / scale
                sample.keypoint_scores = person_scores
                sample.valid_pose = valid_count >= 6
        elif valid_count >= REFINEMENT_MIN_VALID_KEYPOINTS and mean_score >= REFINEMENT_MIN_MEAN_SCORE:
            # Recuperação por pose: o RTMPose encontrou um atleta onde a
            # detecção one-stage falhou; a amostra entra no histórico do track.
            track.history.append(
                TrackSample(
                    frame_index=frame_index,
                    timestamp=timestamp,
                    bbox=track.kalman.project(),
                    keypoints=person_keypoints / scale,
                    keypoint_scores=person_scores,
                    score=mean_score,
                    valid_pose=valid_count >= 6,
                )
            )
            track.time_since_update = 0


def _collect_keyframes(tracker: ByteTracker, frame_index: int, timestamp: float) -> list[dict]:
    """Pose de cada atleta com amostra neste quadro, em pixels do vídeo original."""
    persons = []
    for track in tracker.tracks:
        if not track.confirmed or not track.history:
            continue
        sample = track.history[-1]
        if sample.frame_index != frame_index:
            continue
        kpts = [
            [round(float(x), 1), round(float(y), 1), round(float(s), 2)]
            for (x, y), s in zip(sample.keypoints, sample.keypoint_scores)
        ]
        persons.append({"id": track.track_id, "kpts": kpts})
        if len(persons) >= KEYFRAME_MAX_PERSONS:
            break
    return persons


def analyze_video(
    path: str,
    pose: PoseCallable,
    calibration_points: list[CalibrationPoint] | None = None,
    options: AnalyzeOptions | None = None,
    on_progress: ProgressCallback | None = None,
    refine: PoseCallable | None = None,
) -> dict:
    """Executa o pipeline completo e devolve a análise no contrato da plataforma."""
    options = options or AnalyzeOptions()
    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise ValueError(f"Não foi possível abrir o vídeo: {path}")
    try:
        fps, width, height, duration, size = _video_metadata(capture, path)
        step = max(1, int(round(fps / options.target_fps)))
        sample_rate = fps / step
        calibration = build_calibration(calibration_points) if calibration_points else None
        scale = min(1.0, options.max_frame_width / width) if width else 1.0

        tracker = ByteTracker()
        frame_index = 0
        next_sample = 0
        raw_keyframes: list[dict] = []
        _report(on_progress, 4.0, "Decodificando vídeo")

        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index >= next_sample:
                next_sample += step
                timestamp = frame_index / fps
                if scale < 1.0:
                    frame = cv2.resize(frame, None, fx=scale, fy=scale)
                keypoints, scores = pose(frame, score_thr=options.rtmo_score_thr)
                detections = []
                for person_keypoints, person_scores in zip(keypoints, scores):
                    person_keypoints = np.asarray(person_keypoints, dtype=np.float64).reshape(-1, 2)
                    person_scores = np.asarray(person_scores, dtype=np.float64).reshape(-1)
                    if person_keypoints.shape[0] < 17 or not np.any(person_scores > KEYPOINT_VALID_THRESHOLD):
                        continue
                    detections.append(
                        Detection(
                            bbox=bbox_from_keypoints(person_keypoints, person_scores) / scale,
                            score=person_score(person_scores),
                            keypoints=person_keypoints / scale,
                            keypoint_scores=person_scores,
                        )
                    )
                tracker.update(detections, frame_index, timestamp)
                if refine is not None:
                    _refine_frame(frame, tracker, scale, timestamp, frame_index, refine)
                persons = _collect_keyframes(tracker, frame_index, timestamp)
                if persons:
                    raw_keyframes.append({"t": round(timestamp, 2), "persons": persons})
                if duration > 0 and frame_index % (step * 10) == 0:
                    stage = "Rastreando atletas com pose RTMO + refinamento top-down" if refine is not None else "Rastreando atletas com pose RTMO"
                    _report(on_progress, min(96.0, 4.0 + 92.0 * timestamp / duration), stage)
            frame_index += 1

        if duration <= 0 and frame_index:
            duration = frame_index / fps

        candidates = [track for track in tracker.tracks if track.confirmed] + tracker.finished
        stitched = stitch_tracks(candidates)
        qualified = [
            track
            for track in stitched
            if track.duration >= options.min_track_seconds and len(track.pose_samples) >= options.min_pose_frames
        ]
        if not qualified:
            raise NoPeopleDetected("Nenhum atleta rastreável foi identificado no vídeo.")

        _report(on_progress, 97.0, "Calculando métricas por atleta")
        analyzed = [_analyze_track(track, calibration, sample_rate) for track in qualified]
        analyzed.sort(key=lambda item: item["metrics"].duration_seconds * (item["track"].mean_confidence or 0.01), reverse=True)
        primary = analyzed[0]
        primary_metrics: TrackMetrics = primary["metrics"]

        # Keyframes carregam o ID bruto do fragmento; a costura pós-varredura
        # unifica identidades, então o player recebe o mapa alias -> pessoa.
        alias_to_person: dict[int, int] = {}
        people = []
        events: list[dict] = []
        for item in analyzed:
            track: Track = item["track"]
            metrics: TrackMetrics = item["metrics"]
            for alias in track.merged_ids:
                alias_to_person[alias] = track.track_id
            events.extend(_stroke_events(track.track_id, item["strokeTimes"], track.mean_confidence))
            people.append(
                {
                    "id": track.track_id,
                    "idAliases": sorted(track.merged_ids),
                    "firstSeen": round(track.history[0].timestamp, 2),
                    "lastSeen": round(track.history[-1].timestamp, 2),
                    "durationSeconds": metrics.duration_seconds,
                    "gaps": _track_gaps(track, sample_rate),
                    "strokes": metrics.strokes,
                    "strokeRate": metrics.stroke_rate,
                    "rhythmConsistency": metrics.rhythm_consistency,
                    "avgSpeed": metrics.avg_speed,
                    "maxSpeed": metrics.max_speed,
                    "distance": metrics.distance,
                    "distancePerStroke": metrics.distance_per_stroke,
                    "units": metrics.units,
                    "validity": _metric_validity(metrics, item["stats"], calibration is not None),
                    "meanConfidence": round(track.mean_confidence, 3),
                    "coverage": metrics.coverage,
                    "strokeSignal": item["signal"],
                    "strokeTimes": item["strokeTimes"],
                }
            )
        events.sort(key=lambda event: (event["time"], event["personId"]))

        # O player interpola entre amostras: 6 Hz cobre o olho humano e mantém
        # o registro do vídeo leve no store e no SSE. Fragmentos costurados
        # recebem o ID definitivo aqui, para o esqueleto não trocar de cor.
        stride = max(1, int(np.ceil(sample_rate / KEYFRAME_OUTPUT_HZ)))
        keyframes = raw_keyframes[::stride]
        keyframes_truncated_at = None
        if len(keyframes) > KEYFRAME_OUTPUT_CAP:
            keyframes_truncated_at = keyframes[KEYFRAME_OUTPUT_CAP - 1]["t"]
            keyframes = keyframes[:KEYFRAME_OUTPUT_CAP]
        if alias_to_person:
            for frame in keyframes:
                for person in frame["persons"]:
                    person["id"] = alias_to_person.get(person["id"], person["id"])

        bitrate = int(size * 8 / duration) if duration > 0 and size else 0
        _report(on_progress, 100.0, "Análise concluída")
        return {
            "engine": ENGINE_NAME,
            "engineVersion": ENGINE_VERSION,
            "methodology": METHODOLOGY,
            "analyzedAt": datetime.now(timezone.utc).isoformat(),
            "metadata": {
                "durationSeconds": round(duration, 2),
                "width": width,
                "height": height,
                "fps": round(fps, 2),
                "sizeBytes": size,
                "bitrate": bitrate,
                "units": primary_metrics.units,
                "calibrated": calibration is not None,
                "calibrationRmse": round(calibration.rmse, 3) if calibration else None,
                "persons": len(analyzed),
                "primaryPersonId": primary["track"].track_id,
                "sampleFps": round(sample_rate, 2),
                "keyframesTruncatedAt": keyframes_truncated_at,
            },
            "metrics": {
                "detectedCycles": primary_metrics.strokes,
                "estimatedCadence": int(round(primary_metrics.stroke_rate)),
                "rhythmConsistency": int(round(primary_metrics.rhythm_consistency)),
                "meanMotion": int(round(primary_metrics.mean_motion)),
                "peakMotion": int(round(primary_metrics.peak_motion)),
            },
            "timeline": motion_timeline(primary["times"], primary["points"], calibration),
            "events": events,
            "people": people,
            "keyframes": keyframes,
        }
    finally:
        capture.release()
