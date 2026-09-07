# Correção de rede AWS — 07/09/2026

## Diagnóstico confirmado

O commit `c85bedf` não ligava o Postgres à rede `backend` e marcava essa rede como `internal: true`. A API estava somente em `backend`. Na EC2, alterações não commitadas já corrigiam a configuração; a cópia local continha as mesmas correções.

| Problema | Consequência | Correção versionada |
|---|---|---|
| Postgres na rede default, API na backend | API não consegue resolver/acessar `postgres` pela rede compartilhada | `networks: [backend]` no Postgres |
| Backend interna, única rede da API | API sem saída para serviços externos, incluindo o gateway LLM | Backend sem `internal: true` |
| DNS upstream dependente da configuração do host | Pode impedir resolução externa em uma instalação afetada | `dns: ["1.1.1.1", "8.8.8.8"]` na API |

O DNS interno observado no contêiner é `127.0.0.11`, com os dois servidores acima como upstream. Isso é normal no Docker. Não foi possível comprovar a causa histórica `127.0.0.53` com os dados atuais. `EAI_AGAIN` isoladamente não demonstra essa causa: indica falha temporária na resolução.

Um `git pull` normal não sobrescreve indiscriminadamente alterações locais: ele costuma abortar se a atualização conflitar. O risco era o deploy ficar bloqueado ou uma instalação limpa/restauração do checkout aplicar a configuração defeituosa versionada.

## Exposição e preservação de dados

A rede backend permite saída à internet. API e frontend não publicam portas no host; o Caddy publica HTTP/HTTPS. O Postgres publica `5432` somente em `127.0.0.1`. `expose` não é um firewall nem uma lista de acesso entre contêineres; são os mapeamentos de portas e as regras de rede que controlam acesso externo.

Não execute `docker compose down --volumes` durante um deploy: isso apaga os volumes persistentes.

## Validação preventiva

O workflow `.github/workflows/aws-compose.yml` renderiza a configuração com valores fictícios e executa `scripts/check-aws-compose.mjs` em pushes/PRs relevantes. Ele verifica rede compartilhada, saída externa, DNS, portas e dependência de banco saudável. O workflow detecta a regressão; só bloqueia merges se configurado como check obrigatório nas regras da branch.

Na EC2, sem imprimir configurações que contêm senhas:

```bash
cd /opt/natacao
set -o pipefail
docker compose -f docker-compose.aws.yml config --format json |
  docker compose -f docker-compose.aws.yml exec -T api node --input-type=module -e "$(cat scripts/check-aws-compose.mjs)"
```

Esse comando pressupõe a API já em execução. Para validar antes da primeira instalação, use Node.js 22 no host ou o workflow de CI.

## Teste operacional

```bash
cd /opt/natacao
docker compose -f docker-compose.aws.yml exec -T api node --input-type=module < scripts/smoke-production.mjs
```

O script usa as credenciais já provisionadas no ambiente da API, sem exibi-las. Faz logins temporários de treinador e atleta, verifica permissões e encerra essas sessões. Também faz uma chamada ao modelo configurado com uma mensagem sintética; essa chamada pode consumir créditos do provedor. Não chama o chat contextual da plataforma e não envia dados dos atletas à IA.

Verificações: consulta real ao Postgres, DNS do banco/gateway, HTTPS, API, cookies de sessão, acesso anônimo negado, contas demo desativadas, consultas do treinador, catálogo RKF, disponibilidade do modelo, resposta sintética de IA, restrições de acesso do atleta e revogação de sessões.

## Limites da verificação

HTTP 200 de uma página não comprova todos os seus botões ou fluxos de escrita. Os testes operacionais e as suítes locais dão evidências sobre os caminhos exercitados; não constituem garantia absoluta de toda a plataforma.

O perfil Docker `vision` é opcional e estava desativado na EC2 durante a inspeção. Portanto, não se deve afirmar que o serviço AquaVision estava ativo: a API utiliza o fallback previsto. O perfil possui limite de 3 GB e deve ser dimensionado antes de ativação em uma EC2 com cerca de 2 GB de RAM.

O chat contextual da aplicação monta um snapshot da organização para o provedor externo. O código também contém contexto estático de performance em `buildPerformanceContext()`; conectividade da IA não valida a atualidade nem a precisão desses dados. A revisão desse contexto é uma pendência funcional separada da correção de rede.
