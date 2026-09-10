FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN npm install
COPY tsconfig.base.json ./
COPY packages/domain packages/domain
COPY apps/web apps/web
# Variável pública de runtime no build do Next.js (URL da API no ambiente alvo)
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build -w @natacao/domain && npm run build -w @natacao/web
CMD ["npm", "run", "start", "-w", "@natacao/web"]
