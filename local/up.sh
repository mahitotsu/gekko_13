#!/usr/bin/env bash
# ローカルで、ECS on EC2 の 1 台の構成を docker run で模す。秘密と SVID は local/run/ に置く（git に入れない）。
# - 各サービスは、ECS のタスクと同じく「app」と「svid-helper（spiffe-helper）」の 2 つのコンテナにする。
# - 各コンテナには、ECS のエージェントが付けるのと同じ名前のラベルを付ける。SPIRE の登録はこのラベルで選ぶ。
# - SVID は svid-helper がホストのディレクトリに書き、app は読むだけにする。app は agent のソケットを持たない。
# 手順: SPIRE の server → バンドルと join token → 登録 → agent → サービス。
set -euo pipefail
cd "$(dirname "$0")"
HERE=$(pwd)

TD=gekko13.internal
NODE_ID=spiffe://$TD/node/local
SVID_TTL=${SVID_TTL:-300}
NET=gekko13
SPIRE=1.15.3
HELPER=ghcr.io/spiffe/spiffe-helper:0.11.0
IMAGE=gekko13/node:local
SERVICES=(bff transfer ledger)

mkdir -p run/bundle
for s in "${SERVICES[@]}"; do mkdir -p "run/svid/$s"; done

# 模擬の発行者の client の秘密。local/down.sh で消える
if [ ! -f run/issuer.env ]; then
  BFF_SECRET=$(openssl rand -hex 16) TRANSFER_SECRET=$(openssl rand -hex 16)
  SCOPES='["banking/view","banking/transfer","internal/actor"]'
  cat > run/issuer.env <<EOF
ISSUER=http://issuer:9000
USER_CLIENT_ID=app-client
CLIENTS={"bff-client":{"secret":"$BFF_SECRET","scopes":$SCOPES},"transfer-client":{"secret":"$TRANSFER_SECRET","scopes":$SCOPES}}
EOF
  cat > run/common.env <<EOF
SVID_DIR=/svid
ISSUER=http://issuer:9000
JWKS_URL=http://issuer:9000/.well-known/jwks.json
TOKEN_URL=http://issuer:9000/oauth2/token
USER_CLIENT_ID=app-client
ACTOR_SCOPE=internal/actor
EOF
  printf 'CLIENT_ID=bff-client\nCLIENT_SECRET=%s\n' "$BFF_SECRET" > run/bff.env
  printf 'CLIENT_ID=transfer-client\nCLIENT_SECRET=%s\n' "$TRANSFER_SECRET" > run/transfer.env
  : > run/ledger.env
fi

docker build -q -t "$IMAGE" -f ../Dockerfile "$(../scripts/stage-image.sh)" >/dev/null
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
docker volume create gekko13-agent-sockets >/dev/null

run() { docker run -d --restart unless-stopped --network "$NET" --label gekko13=1 "$@" >/dev/null; }
srv() { docker exec gekko13-spire-server /opt/spire/bin/spire-server "$@"; }

run --name gekko13-spire-server --network-alias spire-server \
  -v "$HERE/spire/server.conf:/etc/spire/server.conf:ro" \
  "ghcr.io/spiffe/spire-server:$SPIRE" -config /etc/spire/server.conf
run --name gekko13-issuer --network-alias issuer --env-file run/issuer.env -e SERVICE=issuer \
  -p 127.0.0.1:19000:9000 "$IMAGE"

until srv healthcheck >/dev/null 2>&1; do sleep 1; done
srv bundle show > run/bundle/bundle.crt
JOIN_TOKEN=$(srv token generate -spiffeID "$NODE_ID" -ttl 600 | awk '/^Token:/ {print $2}')

for s in "${SERVICES[@]}"; do
  srv entry create -parentID "$NODE_ID" -spiffeID "spiffe://$TD/svc/$s" -x509SVIDTTL "$SVID_TTL" \
    -selector "docker:label:com.amazonaws.ecs.task-definition-family:gekko13-$s" \
    -selector "docker:label:com.amazonaws.ecs.container-name:svid-helper" >/dev/null
done

# docker の attestor は、呼び出し元の PID からコンテナを探す。ホストの PID と docker のソケットが要る
run --name gekko13-spire-agent --pid host \
  -v "$HERE/spire/agent.conf:/etc/spire/agent.conf:ro" \
  -v "$HERE/run/bundle:/run/spire/bundle:ro" \
  -v gekko13-agent-sockets:/run/spire/sockets \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  "ghcr.io/spiffe/spire-agent:$SPIRE" -config /etc/spire/agent.conf -joinToken "$JOIN_TOKEN"

declare -A PORT=([bff]=18080 [transfer]=18443 [ledger]=28443)
declare -A INNER=([bff]=8080 [transfer]=8443 [ledger]=8443)
declare -A EXTRA=(
  [bff]="-e NEXT_URL=https://transfer:8443 -e NEXT_ID=spiffe://$TD/svc/transfer"
  [transfer]="-e NEXT_URL=https://ledger:8443 -e NEXT_ID=spiffe://$TD/svc/ledger -e CALLERS={\"spiffe://$TD/svc/bff\":\"bff-client\"}"
  [ledger]="-e CALLERS={\"spiffe://$TD/svc/transfer\":\"transfer-client\"}"
)

for s in "${SERVICES[@]}"; do
  # ホストの利用者で書く。シナリオの実行役が「盗まれた鍵」として読めるようにするため（検証でだけ）
  run --name "gekko13-$s-helper" --user "$(id -u):$(id -g)" \
    --label "com.amazonaws.ecs.task-definition-family=gekko13-$s" --label "com.amazonaws.ecs.container-name=svid-helper" \
    -v gekko13-agent-sockets:/run/spire/sockets:ro \
    -v "$HERE/helper/helper.conf:/etc/helper/helper.conf:ro" \
    -v "$HERE/run/svid/$s:/svid" \
    "$HELPER" -config /etc/helper/helper.conf
  # shellcheck disable=SC2086
  run --name "gekko13-$s" --network-alias "$s" \
    --label "com.amazonaws.ecs.task-definition-family=gekko13-$s" --label "com.amazonaws.ecs.container-name=app" \
    --env-file run/common.env --env-file "run/$s.env" -e "SERVICE=$s" ${EXTRA[$s]} \
    -v "$HERE/run/svid/$s:/svid:ro" \
    -p "127.0.0.1:${PORT[$s]}:${INNER[$s]}" "$IMAGE"
done
echo "立ち上げた。SVID が届くまで数秒かかる: ls local/run/svid/*"
