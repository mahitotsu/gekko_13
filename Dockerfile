# 全サービスで共通のイメージ。SERVICE で動かすサービスを選ぶ。Node.js 24 の型の取り除きで、TypeScript をそのまま動かす。
# RUN を使わない。依存は scripts/stage-image.sh がホストで入れて写す（arm64 のイメージを、エミュレーションなしで作るため）。
# 文脈は scripts/stage-image.sh が作る local/run/image/。
# spire-server の CLI を写す。AWS の段で、server のタスクの registrar（scripts/spire-registrar.sh）が使う。版は aws/deploy.sh と揃える。
ARG SPIRE=1.15.3
FROM ghcr.io/spiffe/spire-server:${SPIRE} AS spire

FROM node:24-alpine
COPY --from=spire /opt/spire/bin/spire-server /usr/local/bin/spire-server
WORKDIR /app
COPY . .
CMD ["sh", "-c", "exec node services/${SERVICE}/src/main.ts"]
