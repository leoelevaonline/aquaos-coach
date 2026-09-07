"""Contrato conservador para métricas esportivas derivadas de vídeo."""

from __future__ import annotations

from typing import Literal

MetricStatus = Literal["measured", "unavailable", "uncalibrated", "not_validated"]

CONTRACT_VERSION = "sports-metrics/v1"

# A convenção é publicada mesmo sem classificador de nado: a classificação do
# estilo é pré-requisito para transformar uma repetição observada em ciclo.
STROKE_CONVENTION = {
    "livre": "Uma braçada é a ação de um braço; um ciclo reúne uma braçada direita e uma esquerda.",
    "costas": "Uma braçada é a ação de um braço; um ciclo reúne uma braçada direita e uma esquerda.",
    "borboleta": "Braçada e ciclo correspondem à ação simultânea dos dois braços.",
    "peito": "Braçada e ciclo correspondem à ação simultânea dos dois braços.",
    "medley": "A convenção muda por trecho conforme o estilo; exige classificação validada do trecho.",
}

_METRICS = (
    ("laps", "voltas", "count", "Não há extrator validado de paredes e extensão da piscina."),
    ("splits", "parciais", "s", "Não há extrator validado de paredes e extensão da piscina."),
    ("pace_100m", "ritmo/100 m", "s/100m", "Depende de voltas medidas e calibração validada."),
    ("speed", "velocidade", "m/s", "A trajetória de pose ainda não é um extrator esportivo validado."),
    ("cycles", "ciclos", "count", "Exige classificador de estilo e extrator de ciclos validados."),
    ("cadence", "cadência", "cycles/min", "Exige ciclos por estilo validados."),
    ("distance_per_cycle", "distância por ciclo", "m/cycle", "Depende de ciclos e distância validados."),
    ("start", "saída", "s", "Não há extrator validado para a fase de saída."),
    ("turn", "virada", "s", "Não há extrator validado para a fase de virada."),
    ("finish", "chegada", "s", "Não há extrator validado para a fase de chegada."),
    ("underwater", "submersão", "s", "Não há extrator validado para a fase de submersão."),
)


def unavailable_sports_metrics(*, source: str, source_version: str, start_seconds: float, end_seconds: float, coverage: float) -> dict:
    """Publica todas as métricas esportivas sem `value` até cada extrator ser validado."""
    interval = {"startSeconds": round(start_seconds, 2), "endSeconds": round(end_seconds, 2)}
    return {
        "contractVersion": CONTRACT_VERSION,
        "strokeConvention": STROKE_CONVENTION,
        "style": {"status": "unavailable", "unavailableReason": "O estilo não foi classificado por extrator validado."},
        "metrics": [
            {
                "id": metric_id,
                "label": label,
                "status": "not_validated",
                "unit": unit,
                "interval": interval,
                "coverage": coverage,
                "source": source,
                "sourceVersion": source_version,
                "unavailableReason": reason,
            }
            for metric_id, label, unit, reason in _METRICS
        ],
    }
