# Acesso ao banco de dados local — AquaOS Coach

Este guia descreve como iniciar, acessar, consultar, exportar e restaurar o PostgreSQL usado pela plataforma no ambiente local.

> Este documento contém apenas as credenciais de desenvolvimento definidas no `docker-compose.yml`. Nunca reutilize esses valores em homologação ou produção e nunca adicione credenciais reais ao Git.

## 1. Pré-requisitos

- Docker Desktop em execução;
- PowerShell aberto na raiz do projeto;
- opcionalmente, um cliente gráfico como DBeaver, DataGrip, TablePlus ou pgAdmin.

Diretório do projeto:

```powershell
Set-Location "C:\Users\leoni\Downloads\natacao"
```

## 2. Iniciar o PostgreSQL

Para iniciar somente o banco:

```powershell
docker compose up -d postgres
```

Para iniciar toda a plataforma:

```powershell
docker compose up -d --build
```

Confirme que o banco está saudável:

```powershell
docker compose ps postgres
docker compose exec postgres pg_isready -U natacao -d natacao
```

O resultado esperado do segundo comando termina com `accepting connections`.

## 3. Dados de conexão local

| Campo | Valor local |
|---|---|
| Host | `localhost` |
| Porta | `5432` |
| Banco | `natacao` |
| Usuário | `natacao` |
| Senha | `natacao` |
| SSL | desabilitado no ambiente local |

URL de desenvolvimento:

```text
postgresql://natacao:natacao@localhost:5432/natacao
```

A API executada dentro do Docker usa o nome do serviço como host:

```text
postgresql://natacao:natacao@postgres:5432/natacao
```

Não use `postgres` como host em programas executados diretamente no Windows; nesse caso, use `localhost`.

## 4. Acessar pelo terminal

O método recomendado não exige instalar o `psql` no Windows:

```powershell
docker compose exec postgres psql -U natacao -d natacao
```

Comandos úteis dentro do `psql`:

```text
\conninfo                 -- mostra a conexão atual
\dn                       -- lista schemas
\dt                       -- lista tabelas
\d nome_da_tabela         -- descreve uma tabela
\x auto                   -- melhora a exibição de registros largos/JSON
\timing on                -- mostra o tempo das consultas
\q                        -- encerra o psql
```

Exemplos de consultas somente leitura:

```sql
SELECT current_database(), current_user, version();

SELECT id, description, applied_at
FROM schema_migrations
ORDER BY id;

SELECT schemaname, tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

SELECT resource_kind, count(*) AS total
FROM app_resources
GROUP BY resource_kind
ORDER BY resource_kind;
```

Para executar uma consulta sem abrir o console interativo:

```powershell
docker compose exec -T postgres psql -U natacao -d natacao -c "SELECT now();"
```

## 5. Acessar por DBeaver, DataGrip, TablePlus ou pgAdmin

Crie uma nova conexão PostgreSQL com os valores da seção **Dados de conexão local**.

Configuração recomendada:

- driver: PostgreSQL;
- host: `localhost`;
- porta: `5432`;
- database: `natacao`;
- usuário e senha: `natacao`;
- SSL: desativado;
- salvar senha: apenas se o computador for pessoal e protegido.

Use a opção **Testar conexão** antes de salvar.

## 6. Estrutura e migrations

O arquivo `infra/postgres/init.sql` cria o schema inicial quando o volume do banco nasce. A API também executa migrations versionadas e idempotentes durante a inicialização.

Tabelas relevantes incluem:

- `schema_migrations`: migrations já aplicadas;
- `app_resources`: estado operacional das entidades da plataforma;
- `app_audit_log`: trilha de auditoria;
- tabelas `rkf_*`: projeções normalizadas de atletas, treinos, prescrições, execuções, respostas, prontidão, cargas, metas, competições, vídeos e documentos;
- `organizations`, `users`, `athletes`, `workout_templates`, `prescriptions`, `completed_workouts`, `wellness_checkins`, `load_snapshots`, `device_connections` e `sync_jobs`: entidades centrais do schema inicial.

Para conferir rapidamente a quantidade de registros em todas as categorias operacionais:

```sql
SELECT resource_kind, count(*) AS registros
FROM app_resources
GROUP BY resource_kind
ORDER BY registros DESC, resource_kind;
```

## 7. Verificar a conexão da API

Com a plataforma iniciada, consulte o health check:

```powershell
Invoke-RestMethod http://localhost:4000/api/v1/health | ConvertTo-Json -Depth 5
```

O retorno esperado deve indicar:

```json
{
  "ok": true,
  "persistence": {
    "driver": "postgres",
    "connected": true
  }
}
```

Se `driver` aparecer como `file`, confirme `DATABASE_URL`, o estado do PostgreSQL e os logs da API.

## 8. Backup local

Crie o diretório de backups, se necessário:

```powershell
New-Item -ItemType Directory -Force -Path ".\backups" | Out-Null
```

Faça um backup completo em formato customizado do PostgreSQL:

```powershell
docker compose exec -T postgres pg_dump -U natacao -d natacao -Fc | Set-Content -AsByteStream ".\backups\natacao-local.dump"
```

Alternativa em SQL legível:

```powershell
docker compose exec -T postgres pg_dump -U natacao -d natacao | Set-Content -Encoding utf8 ".\backups\natacao-local.sql"
```

Verifique se o arquivo foi criado e possui conteúdo:

```powershell
Get-Item ".\backups\natacao-local.dump"
```

Mantenha backups fora do Git. O diretório `backups/` deve permanecer ignorado.

## 9. Restaurar um backup

> A restauração altera dados. Faça um novo backup antes e confirme que está conectado ao banco local.

Para restaurar um arquivo customizado sem apagar o banco inteiro:

```powershell
Get-Content -AsByteStream -Raw ".\backups\natacao-local.dump" |
  docker compose exec -T postgres pg_restore -U natacao -d natacao --clean --if-exists --no-owner
```

Para restaurar um arquivo SQL:

```powershell
Get-Content -Raw ".\backups\natacao-local.sql" |
  docker compose exec -T postgres psql -U natacao -d natacao
```

Depois da restauração, reinicie a API e valide o health check:

```powershell
docker compose restart api
Invoke-RestMethod http://localhost:4000/api/v1/health | ConvertTo-Json -Depth 5
```

## 10. Persistência e reinicialização

Os dados do PostgreSQL ficam no volume Docker `natacao_pgdata`. Parar os contêineres não remove o banco:

```powershell
docker compose down
```

O comando abaixo remove também os volumes e, portanto, apaga o banco local. Só o execute quando quiser recriar o ambiente do zero e já possuir um backup válido:

```powershell
docker compose down --volumes
```

## 11. Solução de problemas

### Porta 5432 já está em uso

Identifique o processo no Windows:

```powershell
Get-NetTCPConnection -LocalPort 5432 -ErrorAction SilentlyContinue
```

Pare a outra instância do PostgreSQL ou altere apenas a porta externa no `docker-compose.yml`, por exemplo `5433:5432`. Nesse caso, clientes no Windows passam a usar a porta `5433`; os contêineres continuam usando `postgres:5432`.

### Banco não fica saudável

```powershell
docker compose ps postgres
docker compose logs --tail 200 postgres
```

### API não conecta

```powershell
docker compose logs --tail 200 api
docker compose exec api node -e "fetch('http://localhost:4000/api/v1/health').then(r => r.text()).then(console.log)"
```

Confirme também que o valor de `DATABASE_URL` usa `localhost` fora do Docker e `postgres` entre contêineres.

### Cliente gráfico não conecta

Verifique, nesta ordem:

1. Docker Desktop está em execução;
2. `docker compose ps postgres` mostra o serviço como saudável;
3. a conexão aponta para `localhost:5432`;
4. o cliente está configurado para PostgreSQL, não MySQL;
5. SSL está desativado no ambiente local.

## 12. Segurança

- Não copie credenciais de produção para `.env`, documentação ou scripts locais versionados.
- Não exponha a porta `5432` à internet.
- Não compartilhe dumps sem remover dados pessoais e de saúde.
- Prefira consultas somente leitura durante inspeções.
- Faça backup antes de executar `UPDATE`, `DELETE`, `TRUNCATE`, restaurações ou alterações de schema.
- Para produção, use somente o procedimento operacional documentado e segredos externos ao código.
