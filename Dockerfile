# syntax=docker/dockerfile:1
# Node のサービス（顧客のアプリ、営業 AI エージェント）で共通のイメージ。SERVICE で動かすサービスを選ぶ。
# Node.js 24 の型の取り除きで、TypeScript をそのまま動かす。文脈はリポジトリの直下で、写すものは .dockerignore で絞る。
# 依存の取り込みと画面のビルドは、ビルドする側の CPU（BUILDPLATFORM）の段で動かすので、arm64 のイメージもエミュレーションなしで作れる。
# npm のキャッシュは BuildKit に置く。依存の層とコードの層を分け、コードだけを直したときは、依存の層を送り直さない。
# 動かす依存は JavaScript だけで、CPU に依らない（CPU ごとの部品が入ると、ここで止める）。
# spire-server の CLI を写す。AWS の段で、server のタスクの registrar（scripts/spire-registrar.sh）が使う。版は aws/deploy.sh と揃える。
ARG SPIRE=1.15.3
FROM ghcr.io/spiffe/spire-server:${SPIRE} AS spire

FROM --platform=$BUILDPLATFORM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && test -z "$(find node_modules -name '*.node')"

FROM --platform=$BUILDPLATFORM node:24-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY packages packages
COPY services/customer-app services/customer-app
RUN cd services/customer-app && npx --no-install vite build --logLevel error

FROM node:24-alpine
COPY --from=spire /opt/spire/bin/spire-server /usr/local/bin/spire-server
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY scripts/spire-registrar.sh scripts/helper-conf.sh scripts/
COPY packages packages
COPY services/customer-app services/customer-app
COPY services/sales-agent services/sales-agent
COPY --from=web /app/services/customer-app/dist services/customer-app/dist
CMD ["sh", "-c", "exec node services/${SERVICE}/src/main.ts"]
