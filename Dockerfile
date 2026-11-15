# 全サービスで共通のイメージ。SERVICE で動かすサービスを選ぶ。Node.js 24 の型の取り除きで、TypeScript をそのまま動かす。
# RUN を使わない。依存は scripts/stage-image.sh がホストで入れて写す（arm64 のイメージを、エミュレーションなしで作るため）。
# 文脈は scripts/stage-image.sh が作る local/run/image/。
FROM node:24-alpine
WORKDIR /app
COPY . .
CMD ["sh", "-c", "exec node services/${SERVICE}/src/main.ts"]
