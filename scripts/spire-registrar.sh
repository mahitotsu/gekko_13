#!/bin/sh
# AWS の段: SPIRE server のタスクの中で動き、登録を作り、バンドルを EFS に書き続ける（aws/ecs.yaml の registrar）。
# 何度動かしても同じ結果になる。登録の手順を、ホストの数と配置から切り離すため、ホストではなくここで行う。
# agent は、ここで書いたバンドルを、最初に server を信じるために読む（trust_bundle_path）。
# 環境変数: SPIRE_SOCKET（server の管理用ソケット）、TRUST_DOMAIN、PREFIX、SVID_TTL、BUNDLE_DIR
set -eu
SOCK=${SPIRE_SOCKET:?}
TD=${TRUST_DOMAIN:?}
PREFIX=${PREFIX:?}
TTL=${SVID_TTL:?}
OUT=${BUNDLE_DIR:?}
NODE="spiffe://$TD/node/ecs"

srv() { spire-server "$@" -socketPath "$SOCK"; }

until srv healthcheck >/dev/null 2>&1; do sleep 2; done
echo "registrar: server is healthy"

# 同じ SPIFFE ID の登録があれば作らない
ensure() {
  id=$1
  shift
  if srv entry show -spiffeID "$id" | grep -q "Entry ID"; then
    echo "registrar: exists $id"
  else
    srv entry create -spiffeID "$id" "$@" >/dev/null
    echo "registrar: created $id"
  fi
}

# ノード: タグ gekko13-role=ecs-host を持つインスタンスの agent。台がいくつでも、この 1 つで足りる
ensure "$NODE" -node -selector aws_iid:tag:gekko13-role:ecs-host
for s in bff transfer ledger; do
  ensure "spiffe://$TD/svc/$s" -parentID "$NODE" -x509SVIDTTL "$TTL" \
    -selector "docker:label:com.amazonaws.ecs.task-definition-family:$PREFIX-$s" \
    -selector "docker:label:com.amazonaws.ecs.container-name:svid-helper"
done

# CA は入れ替わるので、バンドルを 60 秒ごとに書き直す。新しい台の agent が、いつ起きても今のバンドルを読めるように
while :; do
  if srv bundle show > "$OUT/bundle.crt.tmp" && ! cmp -s "$OUT/bundle.crt.tmp" "$OUT/bundle.crt" 2>/dev/null; then
    mv "$OUT/bundle.crt.tmp" "$OUT/bundle.crt"
    echo "registrar: bundle written"
  fi
  sleep 60
done
