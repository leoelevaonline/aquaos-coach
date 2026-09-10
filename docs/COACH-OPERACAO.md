# Operação do treinador — reorganização

## Áreas

- **Hoje:** Treino do dia, Painel Readiness por atleta, carga da equipe e sessões publicadas na data com objetivos individuais.
- **Treinos:** Dia, Microciclo semanal, Mesociclo, Macrociclo e bibliotecas. Navegação diária respeita a data local. Volume do calendário não é apresentado como carga fisiológica.
- **Temporada:** macrociclos cadastrados completos, com mesociclos e microciclos vinculados, edição de fases e painel de prontidão.
- **Análise:** Controle de Carga por atleta, diário e acumulado. O endereço legado `/pt/coach/rkf` também abre essa área.
- **Prova Perfeita:** planos editáveis por atleta, estratégias, ciclos de braçada planejados, sugestões de IA para revisão e conversor proporcional de tempos.
- **Protocolos:** acervo pesquisável de séries, testes e outros protocolos, com criação, edição, exclusão confirmada e uso no treino.
- **Atualização do Dia:** auditoria e observações da comissão filtradas por data. A interface informa o limite de 500 eventos recentes da auditoria.
- **RKF IA:** conversa com escolha do idioma da resposta (português, inglês, espanhol ou francês).

## Preparar uma sessão

Criar treino oferece RKF IA escreve, Coach escreve, Pesquisar exemplos e Pesquisar séries. A pesquisa consulta o acervo interno, não a internet. Ideias e rascunhos passam pelo editor antes da publicação. Uma sugestão da IA nunca publica nem adapta automaticamente uma sessão.

## Revisão técnica de vídeo

Em Vídeos, abra **Revisão técnica de vídeo → Abrir ferramentas** e escolha um vídeo já carregado. Os recursos são próprios da plataforma, não uma integração com o aplicativo Coach’s Eye.

1. Selecione um segundo vídeo para comparar lado a lado e alinhe os tempos.
2. Escolha velocidade de reprodução e FPS de referência para avançar/retroceder quadros.
3. Desenhe linhas e círculos com dois pontos ou ângulos com três pontos.
4. Grave comentários de até dois minutos, concedendo permissão ao microfone.
5. Use **Salvar revisão** para persistir desenhos e referências de áudio no vídeo.

Desenhos e comentários têm timestamps. Áudios são armazenados como documentos WAV vinculados ao vídeo. Remover um comentário da revisão não apaga o documento original. Não há exportação de um vídeo composto com desenhos e narração nesta entrega. Ângulos são medidas 2D; avanço por FPS é aproximado para fontes com taxa de quadros variável. Captura de microfone exige localhost ou HTTPS e suporte a MediaRecorder/AudioContext.

## Origem, cálculo e limites

- A prontidão exibida vem de `readinessScores`. Carga, devices, respostas do atleta e avaliação da comissão são evidências identificadas separadamente. Não foi inventada uma fórmula ponderada para uni-las.
- Carga interna usa sessões RKF persistidas: PSE × duração. ATL/CTL reutilizam `computeChronicSeries`, incluindo os estágios de inicialização do histórico e parâmetros já existentes.
- TSS somente aparece quando fornecido explicitamente, sem conversão implícita a partir de unidades arbitrárias.
- Dados ausentes aparecem como ausência, não como zero. A data da evidência permite identificar registros antigos.
- O conversor calcula ritmo proporcional e aceita ajuste informado pelo treinador. Não é previsão de desempenho ou tabela oficial de equivalência de piscina.
- Novas integrações com dispositivos não fazem parte desta entrega. O painel consome registros que já estiverem disponíveis.
- Idioma da resposta da IA não equivale à tradução completa da interface.
- A IA requer provedor configurado e acessível. Os testes de interface simulam suas respostas; não validam disponibilidade ou qualidade do provedor em produção.

## Persistência e validação

`racePlans`, `protocols` e `staffAssessments` usam o mecanismo de recursos gerenciados, com escopo por organização, autorização e auditoria existentes. Os módulos recarregam dados ao receber eventos da plataforma.

Comandos de validação na raiz:

```powershell
npm run typecheck
npm test
npm run build -w @natacao/api
npm run build -w @natacao/web
$env:FRONTEND_URL = "http://localhost:3000"
npm run test:e2e -w @natacao/web -- coach-reorganization.spec.ts --workers=1
```

Os testes de navegação usam API simulada e um vídeo sintético gerado no navegador; os testes da API verificam persistência, edição, exclusão, auditoria e isolamento dos novos recursos. A validação em dispositivos físicos e a homologação do provedor de IA devem ser feitas no ambiente de homologação antes da liberação operacional.
