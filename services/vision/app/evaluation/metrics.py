"""Métricas reproduzíveis para anotações de rastreamento multiatleta."""

from __future__ import annotations

from collections import Counter
from typing import Any

import numpy as np
from scipy.optimize import linear_sum_assignment


def _iou(left: list[float], right: list[float]) -> float:
    ax1, ay1, ax2, ay2 = left
    bx1, by1, bx2, by2 = right
    intersection = max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(0.0, min(ay2, by2) - max(ay1, by1))
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - intersection
    return intersection / union if union > 0 else 0.0


def _frames(document: dict[str, Any]) -> dict[int, list[dict[str, Any]]]:
    return {int(frame["frame"]): frame.get("objects", []) for frame in document["frames"]}


def _matches(expected: list[dict[str, Any]], predicted: list[dict[str, Any]], threshold: float) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    candidates = [
        (_iou(truth["bbox"], prediction["bbox"]), str(truth["id"]), str(prediction["id"]), truth, prediction)
        for truth in expected
        for prediction in predicted
    ]
    # Desempate explícito torna o protocolo estável entre máquinas e versões.
    candidates.sort(key=lambda item: (-item[0], item[1], item[2]))
    used_truth, used_prediction, matches = set(), set(), []
    for overlap, truth_id, prediction_id, truth, prediction in candidates:
        if overlap < threshold or truth_id in used_truth or prediction_id in used_prediction:
            continue
        used_truth.add(truth_id)
        used_prediction.add(prediction_id)
        matches.append((truth, prediction))
    return matches


def _idf1(pair_counts: Counter[tuple[str, str]], total_truth: int, total_prediction: int) -> tuple[int, float]:
    truth_ids = sorted({pair[0] for pair in pair_counts})
    prediction_ids = sorted({pair[1] for pair in pair_counts})
    if not truth_ids or not prediction_ids:
        return 0, 0.0
    matrix = np.array([[-pair_counts[(truth_id, prediction_id)] for prediction_id in prediction_ids] for truth_id in truth_ids])
    rows, columns = linear_sum_assignment(matrix)
    idtp = int(sum(-matrix[row, column] for row, column in zip(rows, columns)))
    denominator = total_truth + total_prediction
    return idtp, (2.0 * idtp / denominator) if denominator else 0.0


def evaluate_tracking(annotations: dict[str, Any], predictions: dict[str, Any], iou_threshold: float = 0.5) -> dict[str, Any]:
    """Calcula detecção, cobertura, IDF1, switches e fragmentação por sequência."""
    truth_frames, predicted_frames = _frames(annotations), _frames(predictions)
    if annotations["sequenceId"] != predictions["sequenceId"]:
        raise ValueError("sequenceId de anotações e predições deve coincidir")
    if not 0 < iou_threshold <= 1:
        raise ValueError("iou_threshold deve estar entre 0 e 1")

    true_positives = false_positives = false_negatives = 0
    pair_counts: Counter[tuple[str, str]] = Counter()
    last_prediction: dict[str, str] = {}
    identity_switches = 0
    fragments: Counter[str] = Counter()
    seen_prediction: dict[str, str] = {}

    for frame_index in sorted(set(truth_frames) | set(predicted_frames)):
        truth, predicted = truth_frames.get(frame_index, []), predicted_frames.get(frame_index, [])
        matches = _matches(truth, predicted, iou_threshold)
        true_positives += len(matches)
        false_negatives += len(truth) - len(matches)
        false_positives += len(predicted) - len(matches)
        present_truth = {str(item["id"]) for item in truth}
        matched_truth = set()
        for truth_item, prediction_item in matches:
            truth_id, prediction_id = str(truth_item["id"]), str(prediction_item["id"])
            matched_truth.add(truth_id)
            pair_counts[(truth_id, prediction_id)] += 1
            if truth_id in last_prediction and last_prediction[truth_id] != prediction_id:
                identity_switches += 1
            if seen_prediction.get(truth_id) != prediction_id:
                if truth_id in seen_prediction:
                    fragments[truth_id] += 1
                seen_prediction[truth_id] = prediction_id
            last_prediction[truth_id] = prediction_id
        for truth_id in present_truth - matched_truth:
            last_prediction.pop(truth_id, None)

    precision = true_positives / (true_positives + false_positives) if true_positives + false_positives else 0.0
    recall = true_positives / (true_positives + false_negatives) if true_positives + false_negatives else 0.0
    f1 = 2.0 * precision * recall / (precision + recall) if precision + recall else 0.0
    total_truth = true_positives + false_negatives
    total_prediction = true_positives + false_positives
    idtp, idf1 = _idf1(pair_counts, total_truth, total_prediction)
    return {
        "sequenceId": annotations["sequenceId"],
        "iouThreshold": iou_threshold,
        "detection": {"tp": true_positives, "fp": false_positives, "fn": false_negatives, "precision": precision, "recall": recall, "f1": f1},
        "coverage": {"matchedFrames": true_positives, "annotatedFrames": total_truth, "rate": true_positives / total_truth if total_truth else 0.0},
        "identity": {"idtp": idtp, "idfp": total_prediction - idtp, "idfn": total_truth - idtp, "idf1": idf1, "switches": identity_switches, "fragmentations": sum(fragments.values()), "fragmentationsByGroundTruthId": dict(sorted(fragments.items()))},
        "hota": {"value": None, "status": "requires-trackeval", "reason": "HOTA deve ser calculado pela integração TrackEval descrita no protocolo; este script não simula o resultado."},
    }


def summarize_telemetry(telemetry: dict[str, Any]) -> dict[str, Any]:
    """Resume telemetria observada de uma execução, sem inferir tempo real."""
    processed, received = int(telemetry["framesProcessed"]), int(telemetry["framesReceived"])
    elapsed_ms = float(telemetry["wallTimeMs"])
    if processed < 0 or received < processed or elapsed_ms <= 0:
        raise ValueError("telemetria inválida: frames ou wallTimeMs")
    stages = {}
    for name, values in sorted(telemetry.get("stageLatencyMs", {}).items()):
        samples = np.asarray(values, dtype=float)
        if samples.size == 0 or np.any(samples < 0):
            raise ValueError(f"latência inválida para etapa {name}")
        stages[name] = {"count": int(samples.size), "meanMs": float(samples.mean()), "p50Ms": float(np.percentile(samples, 50)), "p95Ms": float(np.percentile(samples, 95))}
    queue = np.asarray(telemetry.get("queueWaitMs", []), dtype=float)
    memory = np.asarray(telemetry.get("memoryRssBytes", []), dtype=float)
    return {"observedFps": processed * 1000.0 / elapsed_ms, "frames": {"received": received, "processed": processed, "dropped": received - processed, "dropRate": (received - processed) / received if received else 0.0}, "stages": stages, "queue": {"samples": int(queue.size), "meanWaitMs": float(queue.mean()) if queue.size else None, "p95WaitMs": float(np.percentile(queue, 95)) if queue.size else None}, "memory": {"samples": int(memory.size), "peakRssBytes": int(memory.max()) if memory.size else None}}
