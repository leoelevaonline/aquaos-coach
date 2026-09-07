# AquaVision - serviço de visão

Microservice Python (FastAPI) que analisa vídeos de natação com pose one-stage
**RTMO** (OpenMMLab, Apache-2.0, via `rtmlib`/ONNX Runtime), refinada por
**RTMPose top-down** no crop de cada atleta rastreado, rastreio multi-atleta
estilo **BYTE** com filtro de Kalman, suavização zero-fase Savitzky-Golay e
calibração opcional por homografia para métricas em metros. A API Node chama
`POST /analyze` e cai no AquaMotion (FFmpeg) se este serviço estiver
indisponível.

O refinamento top-down roda uma segunda inferência por atleta sobre o crop da
própria caixa (prevista pelo Kalman quando a detecção enfraquece): keypoints de
alta resolução durante submersão parcial e recuperação de amostras quando a
pose no crop é inequívoca (>= 8 keypoints válidos com confiança média >= 0,5).
Desligue com `VISION_REFINEMENT=0` ou `{"refinement": false}` na requisição.

A resposta inclui `keyframeSegments` (pose por atleta a ~6 Hz, no espaço do vídeo
original, no máximo 600 amostras): a UI interpola e desenha o esqueleto em
tempo real sincronizado com o player. Fragmentos costurados após submersão
recebem o ID definitivo do atleta nos keyframes (`people[].idAliases` lista os
IDs brutos). Quando o vídeo excede o limite de amostras,
em segmentos de 10 s. A API da plataforma fornece apenas a janela temporal
pedida pelo player, sem transferir a pose do vídeo inteiro ao navegador.

Cada entrada de `people` traz `gaps`, `observedDurationSeconds`,
`observedSegments` e `validity` por métrica. Distância, velocidade, ciclos e
distância por ciclo são calculados somente dentro de trechos observados.
Cadência exige dois intervalos válidos e consistência rítmica exige três.

`maxSpeed` é a maior velocidade derivada da trajetória suavizada; o p95 é usado
somente para normalizar o gráfico de movimento. A `confidence` de eventos é
`heuristic_signal_quality`: qualidade do sinal, nunca probabilidade de acerto.
Velocidade e distância só saem de `uncalibrated` com homografia.

## Rodar

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --port 8800   # baixa o modelo no 1º início
```

Sem Docker, `VISION_MEDIA_ROOT` aponta para `apps/api/storage/uploads` do
repositório por padrão. No Docker, o `docker-compose.yml` sobe o serviço como
`vision` montando o mesmo volume de uploads da API (caminhos absolutos
idênticos) e o cache de modelos em `natacao_vision_models`.

## Endpoints

- `GET /health` - `ok`, `loading` (modelo baixando) ou degradado.
- `POST /analyze` - corpo `{ "path": "...", "calibration"?: {...}, "targetFps"?, "minTrackSeconds"? }`.
  Respostas: 200 com a análise (contrato `metrics`/`timeline`/`events` +
  `people` por atleta); 404 vídeo ausente; 422 sem atletas rastreáveis ou
  calibração degenerada; 503 modelo indisponível ou serviço ocupado.

Calibração: 4+ pares `image` (pixels) para `world` (metros) não colineares,
por exemplo cantos de raia. Habilita velocidade (m/s), distância (m) e metros
por braçada; o RMSE da homografia é reportado em `metadata.calibrationRmse`.

## CLI de diagnóstico

```bash
.venv/bin/python -m app.cli ../../apps/api/storage/uploads/treino.mp4 --json saida.json
```

## Testes

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
```

Os testes rodam sem o modelo real (pose injetável + vídeos sintéticos).

## Avaliação quantitativa e benchmark

O protocolo versionado, schemas de corpus/anotação/telemetria, CLI determinística
e gate contra alegações sem evidência ficam em
[`app/evaluation/README.md`](app/evaluation/README.md). Ele não inclui corpus
nem resultados e os testes sintéticos validam somente os cálculos.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `VISION_MODEL_DIR` | `./models` | Cache dos pesos ONNX (RTMO ~85 MB + RTMPose ~50 MB) |
| `VISION_MEDIA_ROOT` | `apps/api/storage/uploads` | Raiz para caminhos relativos |
| `VISION_DEVICE` | `cpu` | Dispositivo do ONNX Runtime (`cpu`, `cuda:0`) |
| `VISION_MODE` | `balanced` | `lightweight` (rtmo-s), `balanced` (rtmo-m), `performance` (rtmo-l) |
| `VISION_REFINEMENT` | `1` | Refinamento top-down RTMPose por atleta (`0` desliga) |
| `VISION_HOST`/`VISION_PORT` | `0.0.0.0`/`8800` | Bind do uvicorn |

## Notas de precisão

- Modelos de pose treinados em terra degradam na água (respingos, corpo
  ventral, refração). O pipeline assume câmera aérea/borda acima da água;
  cobertura e confiança média por atleta são reportadas para julgar o resultado.
- Detecções fracas (submersão parcial) alimentam apenas a manutenção de tracks
  (segundo estágio BYTE), nunca criam novos atletas.
- Fragmentos do mesmo atleta separados por até 5 s de submersão são costurados
  quando a reentrada é compatível com a velocidade extrapolada e nenhum outro
  atleta esteve ativo na lacuna.
