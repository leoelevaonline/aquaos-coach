from app.sports_metrics import unavailable_sports_metrics


def test_unavailable_contract_never_serializes_synthetic_numbers():
    contract = unavailable_sports_metrics(source="AquaVision", source_version="1.1", start_seconds=1.1, end_seconds=9.9, coverage=87.5)

    for metric in contract["metrics"]:
        assert metric["status"] == "not_validated"
        assert "value" not in metric
        assert metric["interval"] == {"startSeconds": 1.1, "endSeconds": 9.9}
        assert metric["coverage"] == 87.5
