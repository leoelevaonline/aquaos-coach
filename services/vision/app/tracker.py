"""Tracker multi-pessoa estilo BYTE com filtro de Kalman por caixa.

Associação em dois estágios (detecções fortes, depois frac) inspirada em
ByteTrack (Zhang et al., ECCV 2022), reimplementado aqui sob licença permissiva
porque as alternativas empacotadas (ultralytics, boxmot) são AGPL.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linear_sum_assignment

KEYPOINT_COUNT = 17
KEYPOINT_VALID_THRESHOLD = 0.3


@dataclass
class Detection:
    bbox: np.ndarray  # xyxy (4,)
    score: float  # confiança da pessoa (média dos keypoints válidos)
    keypoints: np.ndarray  # (17, 2) em pixels
    keypoint_scores: np.ndarray  # (17,)


@dataclass
class TrackSample:
    frame_index: int
    timestamp: float
    bbox: np.ndarray
    keypoints: np.ndarray
    keypoint_scores: np.ndarray
    score: float
    valid_pose: bool  # pelo menos 6 keypoints acima do limiar


def bbox_from_keypoints(keypoints: np.ndarray, keypoint_scores: np.ndarray) -> np.ndarray:
    """Caixa envolvente da pessoa; prioriza keypoints confiáveis."""
    valid = keypoint_scores > KEYPOINT_VALID_THRESHOLD
    points = keypoints[valid] if valid.sum() >= 2 else keypoints
    if points.size == 0:
        return np.zeros(4, dtype=np.float64)
    return np.array([points[:, 0].min(), points[:, 1].min(), points[:, 0].max(), points[:, 1].max()], dtype=np.float64)


def person_score(keypoint_scores: np.ndarray) -> float:
    """Confiança da pessoa: média dos keypoints sólidos; sem nenhum, a média global (fica baixa)."""
    valid = keypoint_scores[keypoint_scores > KEYPOINT_VALID_THRESHOLD]
    return float(valid.mean()) if valid.size else float(keypoint_scores.mean())


def _to_zh(bbox: np.ndarray) -> tuple[float, float, float, float]:
    width = max(float(bbox[2] - bbox[0]), 1.0)
    height = max(float(bbox[3] - bbox[1]), 1.0)
    return float(bbox[0] + bbox[2]) / 2.0, float(bbox[1] + bbox[3]) / 2.0, width, height


def _to_xyxy(zh: np.ndarray) -> np.ndarray:
    cx, cy, w, h = zh
    return np.array([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], dtype=np.float64)


def iou_matrix(boxes_a: np.ndarray, boxes_b: np.ndarray) -> np.ndarray:
    """IoU par a par entre caixas xyxy (N, 4) e (M, 4)."""
    if boxes_a.size == 0 or boxes_b.size == 0:
        return np.zeros((len(boxes_a), len(boxes_b)), dtype=np.float64)
    top_left = np.maximum(boxes_a[:, None, :2], boxes_b[None, :, :2])
    bottom_right = np.minimum(boxes_a[:, None, 2:], boxes_b[None, :, 2:])
    intersection = np.prod(np.clip(bottom_right - top_left, 0, None), axis=2)
    area_a = np.prod(np.clip(boxes_a[:, 2:] - boxes_a[:, :2], 0, None), axis=1)
    area_b = np.prod(np.clip(boxes_b[:, 2:] - boxes_b[:, :2], 0, None), axis=1)
    union = area_a[:, None] + area_b[None, :] - intersection
    return np.divide(intersection, union, out=np.zeros_like(intersection), where=union > 0)


class KalmanBox:
    """Filtro de Kalman com velocidade constante sobre (cx, cy, w, h)."""

    # Estado [cx, cy, w, h, vx, vy, vw, vh]; medição [cx, cy, w, h].
    F = np.eye(8)
    F[0, 4] = F[1, 5] = F[2, 6] = F[3, 7] = 1.0
    H = np.zeros((4, 8))
    H[0, 0] = H[1, 1] = H[2, 2] = H[3, 3] = 1.0
    Q = np.diag([1.0, 1.0, 1.0, 1.0, 0.01, 0.01, 0.01, 0.01])
    R = np.diag([4.0, 4.0, 25.0, 25.0])

    def __init__(self, bbox: np.ndarray) -> None:
        cx, cy, w, h = _to_zh(bbox)
        self.x = np.array([cx, cy, w, h, 0.0, 0.0, 0.0, 0.0], dtype=np.float64)
        self.p = np.diag([10.0, 10.0, 10.0, 10.0, 1000.0, 1000.0, 1000.0, 1000.0])

    def predict(self) -> np.ndarray:
        self.x = self.F @ self.x
        self.p = self.F @ self.p @ self.F.T + self.Q
        return _to_xyxy(self.x[:4])

    def project(self) -> np.ndarray:
        return _to_xyxy(self.H @ self.x)

    def update(self, bbox: np.ndarray) -> None:
        measurement = np.array(_to_zh(bbox), dtype=np.float64)
        innovation = measurement - self.H @ self.x
        s = self.H @ self.p @ self.H.T + self.R
        gain = self.p @ self.H.T @ np.linalg.inv(s)
        self.x = self.x + gain @ innovation
        identity = np.eye(8)
        self.p = (identity - gain @ self.H) @ self.p


class Track:
    def __init__(self, detection: Detection, track_id: int, frame_index: int, timestamp: float, n_init: int, max_age: int) -> None:
        self.track_id = track_id
        self.n_init = n_init
        self.max_age = max_age
        self.kalman = KalmanBox(detection.bbox)
        self.hits = 1
        self.time_since_update = 0
        self.age = 1
        self.state = "tentative"
        # Permanece true após a confirmação: `confirmed` vira false quando o
        # track morre, e o arquivamento em `finished` precisa saber que ele
        # já teve identidade estabelecida.
        self.established = False
        # IDs de fragmentos costurados neste track: os keyframes ainda os
        # carregam, e o player precisa mapeá-los para uma identidade única.
        self.merged_ids: list[int] = []
        self.history: list[TrackSample] = [
            TrackSample(frame_index, timestamp, detection.bbox.copy(), detection.keypoints.copy(), detection.keypoint_scores.copy(), detection.score, self._has_pose(detection))
        ]

    @staticmethod
    def _has_pose(detection: Detection) -> bool:
        return int((detection.keypoint_scores > KEYPOINT_VALID_THRESHOLD).sum()) >= 6

    def predict(self) -> None:
        self.kalman.predict()
        self.age += 1

    def update(self, detection: Detection, frame_index: int, timestamp: float, counted: bool) -> None:
        self.kalman.update(detection.bbox)
        self.time_since_update = 0
        if counted:
            self.hits += 1
            if self.hits >= self.n_init:
                self.state = "confirmed"
                self.established = True
        self.history.append(
            TrackSample(frame_index, timestamp, detection.bbox.copy(), detection.keypoints.copy(), detection.keypoint_scores.copy(), detection.score, self._has_pose(detection))
        )

    def mark_missed(self) -> None:
        self.time_since_update += 1
        if self.state == "tentative" and self.time_since_update > 3:
            self.state = "deleted"
        elif self.state == "confirmed" and self.time_since_update > self.max_age:
            self.state = "deleted"

    @property
    def confirmed(self) -> bool:
        return self.state == "confirmed"

    @property
    def deleted(self) -> bool:
        return self.state == "deleted"

    @property
    def duration(self) -> float:
        return self.history[-1].timestamp - self.history[0].timestamp

    @property
    def pose_samples(self) -> list[TrackSample]:
        return [sample for sample in self.history if sample.valid_pose]

    @property
    def mean_confidence(self) -> float:
        samples = self.pose_samples
        if not samples:
            return 0.0
        return float(np.mean([np.mean(sample.keypoint_scores[sample.keypoint_scores > KEYPOINT_VALID_THRESHOLD]) for sample in samples]))


def _associate(track_boxes: np.ndarray, detections: list[Detection], iou_threshold: float):
    if len(detections) == 0:
        return [], list(range(len(track_boxes))), []
    det_boxes = np.stack([detection.bbox for detection in detections])
    overlap = iou_matrix(track_boxes, det_boxes)
    rows, cols = linear_sum_assignment(1.0 - overlap)
    matches: list[tuple[int, int]] = []
    unmatched_tracks = [index for index in range(len(track_boxes)) if index not in rows]
    unmatched_dets = [index for index in range(len(detections)) if index not in cols]
    for row, col in zip(rows, cols):
        if overlap[row, col] >= iou_threshold:
            matches.append((int(row), int(col)))
        else:
            unmatched_tracks.append(int(row))
            unmatched_dets.append(int(col))
    return matches, unmatched_tracks, unmatched_dets


@dataclass
class ByteTracker:
    """Rastreio com associação BYTE: detecções frac mantêm tracks durante oclusão."""

    high_thresh: float = 0.40
    low_thresh: float = 0.12
    init_thresh: float = 0.55
    iou_threshold: float = 0.20
    max_age: int = 30
    n_init: int = 3
    tracks: list[Track] = field(default_factory=list)
    finished: list[Track] = field(default_factory=list)
    _next_id: int = 1

    def update(self, detections: list[Detection], frame_index: int, timestamp: float) -> list[Track]:
        for track in self.tracks:
            track.predict()

        high = [detection for detection in detections if detection.score >= self.high_thresh]
        low = [detection for detection in detections if self.low_thresh <= detection.score < self.high_thresh]

        boxes = np.stack([track.kalman.project() for track in self.tracks]) if self.tracks else np.zeros((0, 4))
        matches, unmatched_tracks, unmatched_high = _associate(boxes, high, self.iou_threshold)
        for track_index, det_index in matches:
            self.tracks[track_index].update(high[det_index], frame_index, timestamp, counted=True)

        # Segundo estágio: detecções de baixa confiança apenas atualizam tracks existentes.
        remaining = [self.tracks[index] for index in unmatched_tracks]
        if remaining and low:
            remaining_boxes = np.stack([track.kalman.project() for track in remaining])
            second, still_unmatched, _ = _associate(remaining_boxes, low, self.iou_threshold)
            for track_index, det_index in second:
                remaining[track_index].update(low[det_index], frame_index, timestamp, counted=False)
            for track_index in still_unmatched:
                remaining[track_index].mark_missed()
        else:
            for track in remaining:
                track.mark_missed()

        for det_index in unmatched_high:
            if high[det_index].score >= self.init_thresh:
                self.tracks.append(Track(high[det_index], self._next_id, frame_index, timestamp, self.n_init, self.max_age))
                self._next_id += 1

        # Fragmentos confirmados que morreram ficam disponíveis para a costura
        # pós-varredura (o mesmo atleta reaparece com novo ID após submersão).
        self.finished.extend(track for track in self.tracks if track.deleted and track.established)
        self.tracks = [track for track in self.tracks if not track.deleted]
        return [track for track in self.tracks if track.confirmed and track.time_since_update == 0]


def _center(bbox: np.ndarray) -> np.ndarray:
    return np.array([(bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0])


def _diagonal(bbox: np.ndarray) -> float:
    return float(np.linalg.norm(bbox[2:] - bbox[:2]))


def _mean_velocity(track: Track) -> np.ndarray:
    start = _center(track.history[0].bbox)
    end = _center(track.history[-1].bbox)
    duration = track.duration
    if duration <= 0:
        return np.zeros(2)
    return (end - start) / duration


def stitch_tracks(tracks: list[Track], *, max_gap: float = 5.0, radius_factor: float = 2.5) -> list[Track]:
    """Costura fragmentos do mesmo atleta separados por submersão/oclusão.

    Conservador por construção: só junta quando um fragmento termina antes do
    outro começar, a posição de reentrada é compatível com a velocidade
    extrapolada do anterior e nenhum outro track esteve ativo na lacuna.
    """
    ordered = sorted(tracks, key=lambda track: track.history[0].timestamp)
    merged: list[Track] = []
    for track in ordered:
        target: Track | None = None
        for candidate in merged:
            gap_start = candidate.history[-1].timestamp
            gap_end = track.history[0].timestamp
            gap = gap_end - gap_start
            if not (0 < gap <= max_gap):
                continue
            busy = any(
                other is not candidate
                and other.history[0].timestamp <= gap_end
                and other.history[-1].timestamp >= gap_start
                for other in merged
            )
            if busy:
                continue
            expected = _center(candidate.history[-1].bbox) + _mean_velocity(candidate) * gap
            actual = _center(track.history[0].bbox)
            tolerance = radius_factor * max(_diagonal(track.history[0].bbox), 1.0)
            if float(np.linalg.norm(expected - actual)) <= tolerance:
                target = candidate
                break
        if target is None:
            merged.append(track)
        else:
            target.history.extend(track.history)
            target.merged_ids.extend([track.track_id, *track.merged_ids])
    return merged
