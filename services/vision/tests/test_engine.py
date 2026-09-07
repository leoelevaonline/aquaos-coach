"""Testes do pipeline completo com pose falsa e vídeo sintético."""

from __future__ import annotations

import pytest

from app.calibration import CalibrationPoint
from app.engine import KEYFRAME_OUTPUT_CAP, AnalyzeOptions, analyze_video
from app.errors import NoPeopleDetected
from tests.conftest import FakeRefine

SQUARE = [
    CalibrationPoint(image=(0.0, 0.0), world=(0.0, 0.0)),
    CalibrationPoint(image=(400.0, 0.0), world=(25.0, 0.0)),
    CalibrationPoint(image=(400.0, 200.0), world=(25.0, 12.5)),
    CalibrationPoint(image=(0.0, 200.0), world=(0.0, 12.5)),
]

AT_10HZ = AnalyzeOptions(target_fps=10.0)


def test_single_swimmer_full_contract(video_factory, fake_pose_factory):
    video = video_factory(frames=300, fps=30.0)
    pose = fake_pose_factory([{"start_x": 120.0, "start_y": 120.0, "speed": 20.0, "stroke_hz": 1.0}])
    analysis = analyze_video(video, pose, None, AT_10HZ)

    assert analysis["engine"] == "AquaVision"
    assert analysis["metadata"]["durationSeconds"] == pytest.approx(10.0, abs=0.2)
    assert analysis["metadata"]["persons"] == 1
    assert analysis["metadata"]["units"] == "px"
    assert len(analysis["people"]) == 1

    metrics = analysis["metrics"]
    assert 8 <= metrics["detectedCycles"] <= 12
    assert metrics["estimatedCadence"] == pytest.approx(60, abs=6)
    assert metrics["rhythmConsistency"] > 80
    assert "technicalIndex" not in metrics, "índice técnico sem validação não pode ser publicado"

    assert analysis["timeline"], "timeline não pode ser vazia"
    assert all(0 <= sample["motion"] <= 100 for sample in analysis["timeline"])
    categories = {event["category"] for event in analysis["events"]}
    assert categories == {"stroke"}, "nenhum evento artificial de fase"
    assert all(event["personId"] == analysis["people"][0]["id"] for event in analysis["events"])
    assert analysis["events"] == sorted(analysis["events"], key=lambda event: event["time"])

    person = analysis["people"][0]
    assert person["units"] == "px"
    assert person["gaps"] == []
    assert person["validity"]["strokeRate"] == "measured"
    assert person["validity"]["distance"] == "uncalibrated"
    assert analysis["metadata"]["primaryPersonId"] == person["id"]
    assert analysis["metadata"]["keyframesTruncatedAt"] is None


def test_hidden_swimmer_keeps_single_track(video_factory, fake_pose_factory):
    video = video_factory(frames=300, fps=30.0)
    pose = fake_pose_factory([{"start_x": 120.0, "start_y": 120.0, "speed": 20.0, "stroke_hz": 1.0, "hidden": (4.0, 5.0)}])
    analysis = analyze_video(video, pose, None, AT_10HZ)
    assert len(analysis["people"]) == 1
    assert analysis["people"][0]["coverage"] < 100.0
    assert analysis["people"][0]["durationSeconds"] == pytest.approx(10.0, abs=0.3)
    gaps = analysis["people"][0]["gaps"]
    assert len(gaps) == 1 and gaps[0]["from"] == pytest.approx(4.0, abs=0.3) and gaps[0]["to"] == pytest.approx(5.0, abs=0.3)
    # Fragmentos costurados: os keyframes usam o ID definitivo e os aliases ficam registrados.
    keyframe_ids = {person["id"] for frame in analysis["keyframes"] for person in frame["persons"]}
    assert keyframe_ids == {analysis["people"][0]["id"]}
    aliases = analysis["people"][0]["idAliases"]
    assert all(alias != analysis["people"][0]["id"] for alias in aliases)


def test_two_swimmers_produce_two_entries(video_factory, fake_pose_factory):
    video = video_factory(frames=300, fps=30.0)
    pose = fake_pose_factory(
        [
            {"start_x": 80.0, "start_y": 120.0, "speed": 30.0, "stroke_hz": 1.0},
            {"start_x": 320.0, "start_y": 160.0, "speed": 10.0, "stroke_hz": 0.8},
        ]
    )
    analysis = analyze_video(video, pose, None, AT_10HZ)
    assert analysis["metadata"]["persons"] == 2
    ids = [person["id"] for person in analysis["people"]]
    assert len(set(ids)) == 2
    # Cada atleta tem os próprios eventos de braçada, não só o principal.
    event_people = {event["personId"] for event in analysis["events"]}
    assert event_people == set(ids)


def test_no_person_raises(video_factory, fake_pose_factory):
    video = video_factory(frames=120, fps=30.0)
    pose = fake_pose_factory([])
    with pytest.raises(NoPeopleDetected):
        analyze_video(video, pose, None, AT_10HZ)


def test_calibration_outputs_meters(video_factory, fake_pose_factory):
    video = video_factory(frames=300, fps=30.0)
    pose = fake_pose_factory([{"start_x": 60.0, "start_y": 100.0, "speed": 100.0, "stroke_hz": 1.0}])
    analysis = analyze_video(video, pose, SQUARE, AT_10HZ)
    assert analysis["metadata"]["calibrated"] is True
    assert analysis["metadata"]["units"] == "m"
    person = analysis["people"][0]
    # 100 px/s * 0.0625 m/px = 6.25 m/s
    assert person["avgSpeed"] == pytest.approx(6.25, abs=0.8)
    assert person["distance"] == pytest.approx(62.5, abs=3.0)


def test_progress_callback_reports_stages(video_factory, fake_pose_factory):
    video = video_factory(frames=300, fps=30.0)
    pose = fake_pose_factory([{"start_x": 120.0, "start_y": 120.0, "speed": 20.0, "stroke_hz": 1.0}])
    reports: list[tuple[float, str]] = []
    analyze_video(video, pose, None, AnalyzeOptions(target_fps=10.0), on_progress=lambda value, stage: reports.append((value, stage)))
    assert reports, "nenhum estágio reportado"
    assert reports[-1][0] == 100.0
    assert all(0 <= value <= 100 for value, _ in reports)


def test_refinement_upgrades_pose_quality(video_factory, fake_pose_factory):
    video = video_factory(frames=300, fps=30.0)
    # Detecção fraca (0.55) no one-stage; refinamento devolve 0.85 no crop.
    pose = fake_pose_factory([{"start_x": 120.0, "start_y": 120.0, "speed": 20.0, "stroke_hz": 1.0, "confidence": 0.55}])
    weak = analyze_video(video, pose, None, AT_10HZ)
    assert weak["people"][0]["meanConfidence"] == pytest.approx(0.55, abs=0.03)

    pose_strong = fake_pose_factory([{"start_x": 120.0, "start_y": 120.0, "speed": 20.0, "stroke_hz": 1.0, "confidence": 0.55}])
    refined = analyze_video(video, pose_strong, None, AT_10HZ, refine=FakeRefine(sample_rate=10.0))
    assert refined["people"][0]["meanConfidence"] == pytest.approx(0.85, abs=0.03)
    assert refined["metrics"]["detectedCycles"] >= 8


def test_refinement_recovers_long_submersion(video_factory, fake_pose_factory):
    video = video_factory(frames=300, fps=30.0)
    swimmer = {"start_x": 120.0, "start_y": 120.0, "speed": 20.0, "stroke_hz": 1.0, "hidden": (4.0, 8.0)}
    # Sem refinamento: a costura mantém o mesmo atleta, mas os 4 s de submersão
    # ficam sem pose (cobertura cai para ~60%).
    fragmented = analyze_video(video, fake_pose_factory([swimmer]), None, AT_10HZ)
    assert len(fragmented["people"]) == 1
    assert fragmented["people"][0]["coverage"] < 70.0
    assert fragmented["people"][0]["durationSeconds"] == pytest.approx(10.0, abs=0.4)

    # Com refinamento: a pose no crop previsto pelo Kalman mantém cobertura contínua.
    recovered = analyze_video(video, fake_pose_factory([swimmer]), None, AT_10HZ, refine=FakeRefine(sample_rate=10.0))
    assert len(recovered["people"]) == 1
    assert recovered["people"][0]["durationSeconds"] == pytest.approx(10.0, abs=0.4)
    assert recovered["people"][0]["coverage"] >= 90.0


def test_refinement_failure_is_tolerated(video_factory, fake_pose_factory):
    video = video_factory(frames=300, fps=30.0)
    pose = fake_pose_factory([{"start_x": 120.0, "start_y": 120.0, "speed": 20.0, "stroke_hz": 1.0}])

    def broken_refine(frame, bboxes=None):
        raise RuntimeError("modelo de refinamento indisponível")

    analysis = analyze_video(video, pose, None, AT_10HZ, refine=broken_refine)
    assert analysis["engine"] == "AquaVision"
    assert analysis["metrics"]["detectedCycles"] >= 8


def test_keyframes_contract(video_factory, fake_pose_factory):
    video = video_factory(frames=300, fps=30.0)
    pose = fake_pose_factory([{"start_x": 120.0, "start_y": 120.0, "speed": 20.0, "stroke_hz": 1.0}])
    analysis = analyze_video(video, pose, None, AT_10HZ)
    keyframes = analysis["keyframes"]
    assert keyframes, "keyframes não podem ficar vazios com atleta rastreado"
    times = [frame["t"] for frame in keyframes]
    assert times == sorted(times)
    # Saída limitada a ~6 Hz: o player interpola entre amostras.
    assert all(b - a >= 0.19 for a, b in zip(times, times[1:]))
    for frame in keyframes:
        for person in frame["persons"]:
            assert len(person["kpts"]) == 17
            assert all(len(kpt) == 3 for kpt in person["kpts"])
    # Coordenadas no espaço do vídeo original: nariz segue a trajetória do atleta.
    first = keyframes[0]["persons"][0]["kpts"][0]
    assert first[0] == pytest.approx(120.0, abs=8.0)


def test_keyframes_are_capped(video_factory, fake_pose_factory):
    video = video_factory(frames=4200, fps=30.0)  # 140 s: 700 amostras a 5 Hz > cap
    pose = fake_pose_factory([{"start_x": 120.0, "start_y": 120.0, "speed": 4.0, "stroke_hz": 1.0}])
    analysis = analyze_video(video, pose, None, AT_10HZ)
    assert len(analysis["keyframes"]) <= KEYFRAME_OUTPUT_CAP
    assert analysis["metadata"]["keyframesTruncatedAt"] == analysis["keyframes"][-1]["t"]
    assert analysis["metadata"]["keyframesTruncatedAt"] < analysis["metadata"]["durationSeconds"]
