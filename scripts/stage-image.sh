#!/usr/bin/env bash
# イメージの文脈を local/run/image/ に作る。依存（jose だけ。純粋な JavaScript）はここで入れる。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=local/run/image
rm -rf "$OUT" && mkdir -p "$OUT"
cp package.json package-lock.json "$OUT/"
cp -r packages services "$OUT/"
# 認可サーバー（Java）とログインサーバー（Keycloak）は、それぞれ別のイメージにする。入口の中継は zip で置く（scripts/stage-entry.sh）。
# ここで除くものは、aws/deploy.sh のタグの材料からも除く（材料と中身をそろえる）
rm -rf "$OUT/services/auth" "$OUT/services/keycloak" "$OUT/services/entry"
find "$OUT" -type d -name test -prune -exec rm -rf {} +
# AWS でシナリオを回す実行役（ECS のタスク gekko13-probe）と、3-e の偽の証明書
mkdir -p "$OUT/scripts" && cp scripts/scenarios.ts scripts/soak.ts scripts/target.ts scripts/spire-registrar.sh "$OUT/scripts/"
scripts/make-fake-certs.sh "$OUT/fixtures/fake"
(cd "$OUT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
echo "$(pwd)/$OUT"
