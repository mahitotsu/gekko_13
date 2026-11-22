#!/usr/bin/env bash
# 事務サービス（Python）のイメージの文脈を local/run/python-image/<CPU>/ に作る（段 D の D1-a2-2）。
# 依存は、Docker の Python 3.12 で、動かす側の CPU の wheel だけを取り込む（--only-binary）。イメージの Dockerfile は RUN を使わない
# （arm64 のイメージを、エミュレーションなしで作るため。Node のイメージと同じ考え方）。
# 使い方: scripts/stage-python.sh <amd64|arm64>。作った文脈の場所を出す
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH=${1:?amd64 か arm64}
case $ARCH in
  amd64) PLAT="--platform manylinux2014_x86_64 --platform manylinux_2_28_x86_64" ;;
  arm64) PLAT="--platform manylinux2014_aarch64 --platform manylinux_2_28_aarch64" ;;
  *) echo "知らない CPU: $ARCH" >&2; exit 2 ;;
esac
OUT=local/run/python-image/$ARCH
rm -rf "$OUT" && mkdir -p "$OUT"
cp -r services/insurer-mcp/insurer_mcp services/insurer-mcp/Dockerfile "$OUT/"
docker volume create gekko13-pip >/dev/null
# shellcheck disable=SC2086
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/services/insurer-mcp/requirements.txt:/req.txt:ro" -v "$PWD/$OUT:/out" \
  python:3.12-slim pip install -q --disable-pip-version-check --no-compile --target /out/site $PLAT \
  --implementation cp --python-version 3.12 --only-binary=:all: -r /req.txt >&2
echo "$(pwd)/$OUT"
