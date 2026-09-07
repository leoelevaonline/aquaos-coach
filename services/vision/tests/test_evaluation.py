"""Fixtures sintéticas validam matemática, não desempenho ou precisão real."""

from app.evaluation.metrics import evaluate_tracking, summarize_telemetry
from app.evaluation.claim_gate import validate_claims


def document(frames):
    return {"protocolVersion": "1.0", "sequenceId": "synthetic-crossing", "fps": 30, "frames": frames}


def test_tracking_metrics_count_detection_coverage_identity_switches_and_fragments():
    annotations = document([
        {"frame": 0, "objects": [{"id": "a", "bbox": [0, 0, 10, 10]}]},
        {"frame": 1, "objects": [{"id": "a", "bbox": [1, 0, 11, 10]}]},
        {"frame": 2, "objects": [{"id": "a", "bbox": [2, 0, 12, 10]}]},
    ])
    predictions = document([
        {"frame": 0, "objects": [{"id": "p1", "bbox": [0, 0, 10, 10]}]},
        {"frame": 1, "objects": [{"id": "p2", "bbox": [1, 0, 11, 10]}, {"id": "fp", "bbox": [30, 0, 40, 10]}]},
        {"frame": 2, "objects": []},
    ])
    result = evaluate_tracking(annotations, predictions)
    assert result["detection"] == {"tp": 2, "fp": 1, "fn": 1, "precision": 2 / 3, "recall": 2 / 3, "f1": 2 / 3}
    assert result["coverage"]["rate"] == 2 / 3
    assert result["identity"]["switches"] == 1
    assert result["identity"]["fragmentations"] == 1
    assert result["hota"]["value"] is None


def test_telemetry_summary_reports_fps_drops_latency_memory_and_queue():
    summary = summarize_telemetry({"framesReceived": 100, "framesProcessed": 90, "wallTimeMs": 3000, "stageLatencyMs": {"pose": [10, 20, 30]}, "queueWaitMs": [1, 5], "memoryRssBytes": [100, 200]})
    assert summary["observedFps"] == 30
    assert summary["frames"] == {"received": 100, "processed": 90, "dropped": 10, "dropRate": 0.1}
    assert summary["stages"]["pose"]["p95Ms"] == 29
    assert summary["memory"]["peakRssBytes"] == 200
    assert summary["queue"]["meanWaitMs"] == 3


def test_quantitative_claim_gate_requires_authorized_eval_evidence():
    assert validate_claims({"claims": ["Precisão de 95%"]})
    assert not validate_claims({"claims": ["Precisão de 95%"], "evidence": {"partition": "eval", "authorizedCorpusManifest": "manifesto.json", "evaluationReport": "run.json"}})
