# Deploy AWS — validação de 2 meses (~US$36 de US$100 em créditos)

Arquitetura: **1 EC2 t3.small** (2 vCPU / 2 GB RAM, us-east-1) rodando
Postgres + API + Web + Caddy via `docker-compose.aws.yml`. HTTPS automático,
sem sleep, uploads persistidos em volume Docker no EBS.

## AquaVision: capacidade recomendada

O AquaVision é opcional e fica apenas na rede interna do Compose, compartilhando
o volume de uploads da API e um volume próprio para modelos. Para habilitá-lo,
planeje uma instância com **ao menos 4 vCPU e 8 GB de RAM**; a configuração atual
de t3.small continua destinada à validação sem esse serviço. Esta é uma
recomendação de capacidade, não um benchmark de desempenho: valide com os vídeos
e a concorrência previstos antes de qualquer alteração em produção.

Ative o perfil apenas na instância dimensionada para ele:

```bash
docker compose -f docker-compose.aws.yml --profile vision up -d --build
```

## Custo estimado (região us-east-1)

| Item | Valor |
|---|---|
| EC2 t3.small 24/7 | ~US$14–15/mês |
| EBS 30 GB gp3 | ~US$2,40/mês |
| Snapshot (opcional, semanal) | ~US$0,50/mês |
| **Total 2 meses** | **~US$34–36** |
| Margem restante dos US$100 | ~US$64 |

> A conta com créditos (plano novo pós-jul/2025) consome o saldo
> automaticamente; nada é cobrado no cartão enquanto houver crédito.
> Configure o alerta de orçamento (passo 1) mesmo assim.

## Arquivos deste diretório

- `docker-compose.aws.yml` — stack completa com limites de memória e Postgres tunado
- `infra/Caddyfile` — proxy reverso com HTTPS (Let's Encrypt) ou HTTP puro
- `infra/aws/user-data.sh` — bootstrap automático da instância
- `infra/aws/.env.aws.example` — variáveis de ambiente

## Passo a passo

### 1. Guardrails de billing (faça antes de qualquer recurso)

```bash
aws budgets create-budget --account-id SEU_ACCOUNT_ID \
  --budget '{"BudgetName":"validacao-2-meses","BudgetLimit":{"Amount":"50","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"seu@email.com"}]}]'
```

### 2. Par de chaves e security group

```bash
aws ec2 create-key-pair --key-name rkf-validation \
  --query 'KeyMaterial' --output text > rkf-validation.pem
chmod 400 rkf-validation.pem

aws ec2 create-security-group --group-name rkf-sg --description "RKF validation"
# use o GroupId retornado abaixo
aws ec2 authorize-security-group-ingress --group-id sg-XXXX --protocol tcp --port 22 --cidr SEU_IP/32
aws ec2 authorize-security-group-ingress --group-id sg-XXXX --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id sg-XXXX --protocol tcp --port 443 --cidr 0.0.0.0/0
```

### 3. Lançar a instância

1. Edite `infra/aws/user-data.sh`: preencha `GITHUB_REPO`, `POSTGRES_PASSWORD`
   (`openssl rand -hex 16`), `CORS_ORIGINS` e `PUBLIC_API_URL`;
2. Sem domínio: deixe o Caddyfile no bloco `:80` e use `http://IP-PÚBLICO` nas duas variáveis;
3. Com domínio: crie um registro A apontando para o IP e use `https://seu-dominio`;

```bash
# user-data não pode ter shebang problemático em JSON — use base64:
USERDATA=$(base64 -w0 infra/aws/user-data.sh)

aws ec2 run-instances \
  --image-id ami-ID-UBUNTU-24.04-da-regiao \
  --instance-type t3.small \
  --key-name rkf-validation \
  --security-group-ids sg-XXXX \
  --user-data file://infra/aws/user-data.sh \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Project,Value=rkf-validation},{Key=Name,Value=rkf-app}]'
```

AMI Ubuntu 24.04: procure "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server" no
EC2 console (free tier eligible) ou `aws ec2 describe-images --owners 099720109477 --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" --query 'sort_by(Images,&CreationDate)[-1].ImageId'`.

### 4. Acompanhar o bootstrap

```bash
ssh -i rkf-validation.pem ubuntu@IP-PUBLICO
tail -f /var/log/user-data.log        # progresso do bootstrap
docker compose -f docker-compose.aws.yml ps
docker compose -f docker-compose.aws.yml logs -f api
```

O build completo (npm install + next build) leva ~8–12 min na t3.small.
Se o user-data (timeout 15 min) não completar, rode manualmente:

```bash
cd /opt/natacao
docker compose -f docker-compose.aws.yml up -d --build
```

### 5. Verificação

```bash
curl http://IP-PÚBLICO/api/v1/health   # {"ok":true,...}
```

Login demo: `coach@natacao.local` / `natacao-demo`
(**desativado em produção** — o `NODE_ENV=production` bloqueia contas demo;
crie usuários reais ou troque o seed do `auth.ts` antes de mostrar ao cliente).

### 6. Atualizar o app (a cada mudança de código)

```bash
ssh -i rkf-validation.pem ubuntu@IP-PÚBLICO
cd /opt/natacao
git pull
docker compose -f docker-compose.aws.yml up -d --build
```

### 7. Backup semanal (barato e suficiente para validação)

```bash
docker exec $(docker ps -qf name=postgres) pg_dump -U natacao natacao | gzip > backup-$(date +%F).sql.gz
# e o volume de uploads:
docker run --rm -v natacao_api_storage:/data -v $PWD:/backup alpine tar czf /backup/uploads-$(date +%F).tar.gz -C /data .
```

Cron na VM: `0 4 * * 0 ubuntu /opt/natacao/scripts/backup.sh` (use o
`scripts/backup.ps1` existente como referência e portue para bash).

## Teardown (encerrou a validação)

```bash
aws ec2 terminate-instances --instance-ids i-XXXX
# confira e remova EIPs soltos e volumes órfãos:
aws ec2 describe-volumes --filters Name=status,Values=available
```

`DeleteOnTermination: true` no EBS já cuida do volume principal.

## Limitações conhecidas desta configuração

- **FFmpeg em vídeo 1080p**: 2 GB + swap aguenta, mas análises simultâneas podem
  enfileirar. Para a validação com 1–2 treinadores é suficiente;
- **Postgres no mesmo host**: sem replicação; backup semanal é a rede de segurança;
- **IP público muda em stop/start**: use Elastic IP (~US$3,6/mês, coberto pela
  margem) ou fixe o DNS após cada start; nunca deixe EIP desanexada (cobra);
- **Sem auto-scaling**: intencional — é um ambiente de validação, não produção.
