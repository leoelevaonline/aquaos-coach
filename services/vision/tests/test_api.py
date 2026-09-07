"""Testes da API HTTP com pose injetada (sem modelo real)."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.conftest import write_video


def make_client(media_root: Path, pose) -> TestClient:
    settings = Settings(
        model_dir=media_root / "models",
        media_root=media_root,
        device="cpu",
        mode="balanced",
        host="127.0.0.1",
        port=8800,
        refinement=False,
    )
    return TestClient(create_app(settings, pose))


class FakePose:
    def __init__(self, swimmers: list[dict]):
        self.swimmers = swimmers
        self.calls = 0

    def __call__(self, frame, score_thr=None, nms_thr=None):
        import numpy as np

        from tests.conftest import skeleton

        time = self.calls / 10.0
        self.calls += 1
        if not self.swimmers:
            return np.zeros((0, 17, 2)), np.zeros((0, 17))
        keypoints, scores = [], []
        for swimmer in self.swimmers:
            cx = swimmer["start_x"] + swimmer.get("speed", 0.0) * time
            wrist = 20.0 * np.sin(2.0 * np.pi * swimmer.get("stroke_hz", 1.0) * time)
            keypoints.append(skeleton((cx, swimmer["start_y"]), wrist))
            scores.append(np.full(17, 0.8))
        return np.stack(keypoints), np.stack(scores)


def test_health_reports_injected_model(tmp_path):
    with make_client(tmp_path, FakePose([{"start_x": 100.0, "start_y": 100.0}])) as client:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"


def test_analyze_returns_full_contract(tmp_path):
    write_video(str(tmp_path / "treino.mp4"), frames=300)
    with make_client(tmp_path, FakePose([{"start_x": 120.0, "start_y": 120.0, "speed": 20.0, "stroke_hz": 1.0}])) as client:
        response = client.post("/analyze", json={"path": "treino.mp4", "targetFps": 10})
        assert response.status_code == 200
        payload = response.json()
        assert payload["engine"] == "AquaVision"
        assert payload["metadata"]["persons"] == 1
        cadence = next(metric for metric in payload["sportMetrics"]["metrics"] if metric["id"] == "cadence")
        assert cadence["status"] == "not_validated"
        assert "value" not in cadence


def test_analyze_missing_video_returns_404(tmp_path):
    with make_client(tmp_path, FakePose([])) as client:
        response = client.post("/analyze", json={"path": "sumiu.mp4"})
        assert response.status_code == 404


def test_analyze_without_persons_returns_422(tmp_path):
    write_video(str(tmp_path / "vazio.mp4"), frames=120)
    with make_client(tmp_path, FakePose([])) as client:
        response = client.post("/analyze", json={"path": "vazio.mp4"})
        assert response.status_code == 422


def test_analyze_rejects_collinear_calibration(tmp_path):
    write_video(str(tmp_path / "treino.mp4"), frames=300)
    calibration = {
        "points": [
            {"image": [0.0, 0.0], "world": [0.0, 0.0]},
            {"image": [100.0, 0.0], "world": [10.0, 0.0]},
            {"image": [200.0, 0.0], "world": [20.0, 0.0]},
            {"image": [300.0, 0.0], "world": [30.0, 0.0]},
        ]
    }
    with make_client(tmp_path, FakePose([{"start_x": 120.0, "start_y": 120.0}])) as client:
        response = client.post("/analyze", json={"path": "treino.mp4", "targetFps": 10, "calibration": calibration})
        assert response.status_code == 422


def test_analyze_accepts_valid_calibration(tmp_path):
    write_video(str(tmp_path / "treino.mp4"), frames=300)
    calibration = {
        "origin": "calibração técnica", "version": "2026.09.1", "cameraId": "camera-fixa-1", "poolId": "piscina-olimpica", "laneIds": ["4"], "coverage": 0.9, "validity": "valid",
        "points": [
            {"image": [0.0, 0.0], "world": [0.0, 0.0]},
            {"image": [400.0, 0.0], "world": [25.0, 0.0]},
            {"image": [400.0, 200.0], "world": [25.0, 12.5]},
            {"image": [0.0, 200.0], "world": [0.0, 12.5]},
        ]
    }
    with make_client(tmp_path, FakePose([{"start_x": 60.0, "start_y": 100.0, "speed": 100.0, "stroke_hz": 1.0}])) as client:
        response = client.post("/analyze", json={"path": "treino.mp4", "targetFps": 10, "calibration": calibration})
        assert response.status_code == 200
        assert response.json()["metadata"]["calibrated"] is True
        assert response.json()["metadata"]["calibrationSnapshot"]["version"] == "2026.09.1"
        availability = response.json()["metadata"]["metricAvailability"]["avgSpeed"]
        assert availability == {"available": False, "reliable": False, "reason": "extrator esportivo não validado"}
        speed = next(metric for metric in response.json()["sportMetrics"]["metrics"] if metric["id"] == "speed")
        assert speed["status"] == "not_validated"
        assert "value" not in speed


def test_analyze_marks_metrics_unreliable_when_calibration_coverage_is_insufficient(tmp_path):
    write_video(str(tmp_path / "treino.mp4"), frames=300)
    calibration = {
        "origin": "calibração técnica", "version": "2026.09.1", "cameraId": "camera-fixa-1", "poolId": "piscina-olimpica", "laneIds": ["4"], "coverage": 0.5, "validity": "valid",
        "points": [{"image": [0.0, 0.0], "world": [0.0, 0.0]}, {"image": [400.0, 0.0], "world": [25.0, 0.0]}, {"image": [400.0, 200.0], "world": [25.0, 12.5]}, {"image": [0.0, 200.0], "world": [0.0, 12.5]}],
    }
    with make_client(tmp_path, FakePose([{"start_x": 60.0, "start_y": 100.0, "speed": 100.0, "stroke_hz": 1.0}])) as client:
        response = client.post("/analyze", json={"path": "treino.mp4", "targetFps": 10, "calibration": calibration})
        assert response.status_code == 200
        availability = response.json()["metadata"]["metricAvailability"]["avgSpeed"]
        assert availability == {"available": False, "reliable": False, "reason": "cobertura da calibração insuficiente"}
