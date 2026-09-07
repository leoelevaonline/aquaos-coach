"""Gate para impedir alegações quantitativas sem evidência de eval autorizada."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

RESTRICTED = re.compile(r"\b(precisão|acurácia|accuracy|precision|tempo real|real[- ]?time|realtime)\b", re.IGNORECASE)


def validate_claims(document: dict) -> list[str]:
    restricted = [claim for claim in document.get("claims", []) if RESTRICTED.search(claim)]
    if not restricted:
        return []
    evidence = document.get("evidence", {})
    if evidence.get("partition") != "eval" or not evidence.get("authorizedCorpusManifest") or not evidence.get("evaluationReport"):
        return ["Alegações de precisão/acurácia ou tempo real exigem manifesto autorizado, partição eval e relatório de avaliação observada."]
    return []


def main() -> None:
    parser = argparse.ArgumentParser(description="Valida alegações contra evidência de avaliação autorizada.")
    parser.add_argument("claims_file")
    args = parser.parse_args()
    errors = validate_claims(json.loads(Path(args.claims_file).read_text(encoding="utf-8")))
    if errors:
        print("GATE BLOQUEADO: " + " ".join(errors), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
