"""CLI determinística para avaliar arquivos autorizados, sem criar corpus."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .metrics import evaluate_tracking, summarize_telemetry


def _read(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Avalia rastreamento a partir de anotações e predições fornecidas.")
    parser.add_argument("--annotations", required=True)
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--telemetry", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--iou-threshold", type=float, default=0.5)
    args = parser.parse_args()
    result = {"protocolVersion": "1.0", "tracking": evaluate_tracking(_read(args.annotations), _read(args.predictions), args.iou_threshold), "performance": summarize_telemetry(_read(args.telemetry)), "disclaimer": "Resultados dependem exclusivamente dos arquivos fornecidos; fixtures sintéticas não comprovam precisão real nem tempo real."}
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
