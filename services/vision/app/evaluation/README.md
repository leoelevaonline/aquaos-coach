# Protocolo de avaliação quantitativa AquaVision (v1.0)

Esta pasta contém **infraestrutura**, formatos e cálculos determinísticos. Não contém vídeos, anotações humanas, corpus autorizado, resultados ou alegações de desempenho.

## Governança do corpus

Antes de executar um benchmark, registre um manifesto conforme `corpus-manifest.v1.json`. Ele separa obrigatoriamente e sem sobreposição:

- **pool**: material elegível, ainda não usado para desenvolvimento;
- **dev**: ajuste de parâmetros e decisões de engenharia;
- **eval**: conjunto bloqueado, usado apenas para o relatório final.

Cada sequência exige autorização rastreável do titular, finalidade permitida e um ID estável. Além da lista de cada partição, `sequences` exige a piscina, câmera, FPS de origem e um ou mais cenários enumerados. O manifesto deve registrar somente IDs e metadados permitidos; mídia e anotações ficam no repositório/armazenamento autorizado separado. Nenhuma sequência de `eval` pode orientar limiares, modelo ou correções antes da execução registrada.

Planeje e estratifique `pool`, `dev` e `eval` para os cenários: **cruzamento, oclusão, reflexo, submersão, virada, borda e câmera móvel**. Registre também piscina, posição da câmera, resolução, FPS de origem, número de atletas e condição de iluminação. A ausência de uma estratificação é uma lacuna a reportar, nunca uma justificativa para inventar cobertura.

## Formatos e execução

`annotation-format.v1.json` descreve tanto verdade-terreno quanto predições por quadro: `id` estável e `bbox` em `[x1, y1, x2, y2]`. `telemetry-format.v1.json` registra a execução observada: quadros recebidos/processados, relógio de parede, latência por etapa, espera de fila e RSS. O benchmark calcula detecção (TP/FP/FN, precisão, revocação e F1), cobertura, IDF1, ID switches, fragmentação, FPS observado, quadros descartados, percentis de latência, memória e fila.

```bash
cd services/vision
.venv/bin/python -m app.evaluation.benchmark \
  --annotations /dados-autorizados/eval/gt.json \
  --predictions /execucoes/run-001/predictions.json \
  --telemetry /execucoes/run-001/telemetry.json \
  --output /execucoes/run-001/report.json
```

O resultado marca HOTA como `requires-trackeval`: a implementação oficial deve ser executada via [TrackEval](https://github.com/JonathonLuiten/TrackEval), exportando o mesmo `eval` para o formato MOTChallenge, com IoU e classes documentados no relatório. Não substitua HOTA por uma aproximação.

## Gates de comunicação

`claim_gate.py` bloqueia texto com “precisão”, “acurácia” ou “tempo real” sem manifesto autorizado, partição `eval` e relatório de avaliação observada:

```bash
cd services/vision
.venv/bin/python -m app.evaluation.claim_gate comunicacao.json
```

O arquivo deve ter `claims` e, quando fizer alegação restrita, `evidence.partition: "eval"`, `authorizedCorpusManifest` e `evaluationReport`. Uma execução que não os apresenta não pode ser divulgada como precisa ou em tempo real.

## Limite dos testes

`tests/test_evaluation.py` usa fixtures sintéticas apenas para validar os cálculos e gates de forma reproduzível. Esses testes **não provam precisão real, generalização, latência de produção ou tempo real**. Somente a avaliação registrada contra um corpus autorizado e separado pode sustentar tais afirmações.
