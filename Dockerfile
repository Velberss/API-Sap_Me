# ── Stage 1: Build ────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Instala apenas dependências de produção
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npx playwright install chromium && \
    npm cache clean --force

# Copia artefatos compilados do stage anterior
COPY --from=builder /app/dist ./dist

# Porta padrão da aplicação
ENV NODE_ENV=production
EXPOSE 3000

# Executa como usuário não-root (já criado na imagem do Playwright)
USER pwuser

CMD ["node", "dist/server.js"]
