#!/usr/bin/env bash
# ローカルで、ECS on EC2 の 1 台の構成を docker run で模す（段 D の D1-a2）。秘密と SVID は local/run/ に置く（git に入れない）。
# - SVID を使うサービスは、ECS のタスクと同じく「app」と「svid-helper（spiffe-helper）」の 2 つのコンテナにする。
# - 各コンテナには、ECS のエージェントが付けるのと同じ名前のラベルを付ける。SPIRE の登録はこのラベルで選ぶ。
# - SVID は svid-helper がホストのディレクトリに書き、app は読むだけにする。app は agent のソケットを持たない。
# - ブラウザは、入口のリバースプロキシ（http://gekko13.localhost:18000）から、AWS の CloudFront と同じパスで使う。
#   /login はログインサーバー、/audit は監査サービス、それ以外は顧客のアプリ。Chromium は *.localhost をループバックに解決する。
# 手順: PostgreSQL → SPIRE の server → バンドルと join token → 登録 → agent → サービス → 入口。
# 使い方: local/up.sh（全部を立てる）。local/up.sh <サービス>...（立っている環境で、そのサービスのイメージを作り直して入れ替える。
#   サービスは keycloak、auth、customer-app、sales-agent、insurer-mcp、insurer-backend、insurer-audit、entry、otel）
#   主の流れの 5 つのサービスは、AWS と同じく 2 つずつ立てる。GEKKO13_LOCAL_REPLICAS で数を変える（段 D の D1-a3）。
#   手元の確かめだけで使う切り方: GEKKO13_FAULT_CUT_STREAM=1（営業 AI エージェントが、回の途中でつなぎを切る）、
#   GEKKO13_FAULT_DROP_SUBMIT_REPLY=1（事務サービスが、最初の提出の返事を捨てる）。
#   GEKKO13_TRACING=1 で、collector（標準出力に書く）を立て、各サービスの計装を入れる（段 T）。
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
AUTH_IMAGE=gekko13/auth:local
KEYCLOAK_IMAGE=gekko13/keycloak:local
MCP_IMAGE=gekko13/insurer-mcp:local
BACKEND_IMAGE=gekko13/insurer-backend:local
AUDIT_IMAGE=gekko13/insurer-audit:local
# 入口の origin。AWS ではディストリビューションのドメイン名
ORIGIN=http://gekko13.localhost:18000
RP_ID=gekko13.localhost
ISSUER=$ORIGIN/login/realms/insurer
# SVID を使うサービス
SERVICES=(auth customer-app sales-agent insurer-mcp insurer-backend insurer-audit)

mkdir -p run/bundle run/helper
for s in "${SERVICES[@]}"; do mkdir -p "run/svid/$s"; done

# 共有の保存先（段 D の D1-a1）の、管理者とサービスごとのパスワード。AWS では Aurora、ここでは PostgreSQL のコンテナ
# 足りない値だけを足す（D1-a3 で、主の流れのサービスの分を足した。前からある run/db.env も使い続けられる）
touch run/db.env
for k in DB_ADMIN DB_SPIRE DB_KEYCLOAK DB_AUTH DB_BACKEND DB_CUSTOMER_APP DB_SALES_AGENT DB_AUDIT; do
  grep -q "^$k=" run/db.env || printf '%s=%s\n' "$k" "$(openssl rand -hex 16)" >> run/db.env
done
# 顧客のアプリのセッションの暗号鍵（AES-256。判断 54）
grep -q "^STATE_KEY=" run/db.env || printf 'STATE_KEY=%s\n' "$(openssl rand -hex 32)" >> run/db.env
# 営業 AI エージェントの会話の暗号鍵（判断 55）。サービスごとに分ける
grep -q "^AGENT_STATE_KEY=" run/db.env || printf 'AGENT_STATE_KEY=%s\n' "$(openssl rand -hex 32)" >> run/db.env
# shellcheck disable=SC1091
. run/db.env
# 保険会社のシステムの提示の鍵（段 D の D1-a3）。AWS と同じく、秘密鍵と公開鍵の PEM を並べ、複数のコンテナが同じ鍵を使う
if [ ! -f run/offer-key.pem ]; then
  (umask 077 && k=$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256) && { printf '%s\n' "$k"; printf '%s\n' "$k" | openssl pkey -pubout; } > run/offer-key.pem)
fi
# SPIRE の bundle endpoint の TLS の証明書（gekko_11 の D-38）。SVID とは関係のない、使い捨ての自己署名の証明書。
# ログインサーバーは、この証明書を信じて、JWT-SVID を確かめる公開鍵を取る
if [ ! -f run/bundle-endpoint/tls.crt ]; then
  mkdir -p run/bundle-endpoint
  openssl req -x509 -newkey rsa:2048 -nodes -keyout run/bundle-endpoint/tls.key -out run/bundle-endpoint/tls.crt -days 3650 \
    -subj "/CN=spire-server" -addext "subjectAltName=DNS:spire-server" >/dev/null 2>&1
  chmod 0644 run/bundle-endpoint/tls.key
fi
# 固定の利用者（alice など）のパスワード。手元では、gekko_11 と同じ値にする
DEMO_PASSWORD=demo

build_node() { docker buildx build -q --load -t "$IMAGE" .. >/dev/null; }
build_auth() { docker buildx build -q --load -t "$AUTH_IMAGE" ../services/auth >/dev/null; }
build_keycloak() { docker buildx build -q --load -t "$KEYCLOAK_IMAGE" ../services/keycloak >/dev/null; }
build_mcp() { docker buildx build -q --load -t "$MCP_IMAGE" ../services/insurer-mcp >/dev/null; }
build_audit() { docker buildx build -q --load -t "$AUDIT_IMAGE" ../services/insurer-audit >/dev/null; }
build_backend() {
  docker buildx build -q --load --build-context vectors=../packages/token-guard/vectors -t "$BACKEND_IMAGE" ../services/insurer-backend >/dev/null
}
run() { docker run -d --restart unless-stopped --network "$NET" --label gekko13=1 "$@" >/dev/null; }
# 主の流れのサービスの数（段 D の D1-a3。AWS と同じく既定は 2）。2 つ目は gekko13-<サービス>-2 で、同じネットワークの別名で立てる。
# docker の DNS は、別名の宛先を両方返すので、呼ぶ側は、どちらかに当たる。SVID の helper は 1 つで、両方が同じ SVID を読む
REPLICAS=${GEKKO13_LOCAL_REPLICAS:-2}
REPLICATED=" customer-app sales-agent insurer-mcp insurer-backend insurer-audit "
R=
# start_<サービス> を、主の流れのサービスなら REPLICAS の数だけ回す
start() {
  local s=$1 i
  if [[ $REPLICATED == *" $s "* ]]; then
    for ((i = 1; i <= REPLICAS; i++)); do
      R=$([ "$i" = 1 ] || echo "-$i")
      "start_${s//-/_}"
    done
    R=
  else
    "start_${s//-/_}"
  fi
}
srv() { docker exec gekko13-spire-server /opt/spire/bin/spire-server "$@"; }

# 各サービスの svid-helper。ホストの利用者で書く。シナリオの実行役が「盗まれた鍵」として読めるようにするため（検証でだけ）。
# auth と顧客のアプリは、ログインサーバーへのクライアント認証に示す JWT-SVID も書かせる（第 2 引数 jwt。宛先は issuer）
helper() {
  local s=$1 aud=
  [ "${2:-}" = jwt ] && aud=$ISSUER
  JWT_AUDIENCE=$aud ../scripts/helper-conf.sh "run/helper/$s.conf"
  run --name "gekko13-$s-helper" --user "$(id -u):$(id -g)" \
    --label "com.amazonaws.ecs.task-definition-family=gekko13-$s" --label "com.amazonaws.ecs.container-name=svid-helper" \
    -v gekko13-agent-sockets:/run/spire/sockets:ro \
    -v "$HERE/run/helper/$s.conf:/etc/helper/helper.conf:ro" \
    -v "$HERE/run/svid/$s:/svid" \
    "$HELPER" -config /etc/helper/helper.conf
}
app_labels() { echo --label "com.amazonaws.ecs.task-definition-family=gekko13-$1" --label "com.amazonaws.ecs.container-name=app"; }

# ログインサーバー（Keycloak と gekko_11 の拡張）。保存先は PostgreSQL。レルムの ${…} は、取り込みのときに環境変数で置き換わる
start_keycloak() {
  # ECS と同じ名前のラベルを付ける（監査サービスが、A の発行の記録の書き手を、このラベルで決める）
  # shellcheck disable=SC2046
  run --name gekko13-keycloak --network-alias keycloak --memory 1g $(app_labels keycloak) \
    -e "KC_HOSTNAME=$ORIGIN/login" -e KC_HTTP_ENABLED=true -e KC_PROXY_HEADERS=xforwarded \
    -e KC_DB_URL=jdbc:postgresql://postgres:5432/keycloak -e KC_DB_USERNAME=keycloak -e "KC_DB_PASSWORD=$DB_KEYCLOAK" \
    -e "BUNDLE_CA_PEM=$(cat run/bundle-endpoint/tls.crt)" -e KC_TRUSTSTORE_PATHS=/tmp/bundle-ca.pem \
    -e "RP_ID=$RP_ID" -e "TRUST_DOMAIN=$TD" -e AUTH_ISSUER=https://auth:8443 \
    -e "APP_ORIGIN=$ORIGIN" -e "AUDIT_ORIGIN=$ORIGIN/audit" -e SPIRE_BUNDLE_ENDPOINT=https://spire-server:8443 \
    -e "DEMO_PASSWORD=$DEMO_PASSWORD" ${KC_LOG_LEVEL:+-e "KC_LOG_LEVEL=$KC_LOG_LEVEL"} \
    -p 127.0.0.1:18180:8080 "$KEYCLOAK_IMAGE"
}

# 認可サーバー。メモリを 512 MB に絞って動かす（段 C の C-3 の見当にする）
start_auth() {
  # shellcheck disable=SC2046
  run --name gekko13-auth --network-alias auth --memory 512m $(app_labels auth) $(trace auth java) \
    -e SVID_DIR=/svid -e ISSUER=https://auth:8443 -e "TRUST_DOMAIN=$TD" \
    -e "LOGIN_ISSUER=$ISSUER" -e LOGIN_URL=http://keycloak:8080/login -e JWT_SVID_FILE=/svid/jwt_svid.token \
    -e DB_URL=jdbc:postgresql://postgres:5432/auth -e DB_USER=auth -e "DB_PASSWORD=$DB_AUTH" \
    -v "$HERE/run/svid/auth:/svid:ro" \
    -p 127.0.0.1:19443:8443 "$AUTH_IMAGE"
}

# 顧客のアプリ（画面の配信元と BFF）。8080 は入口から、9443 は保険会社のシステムからの直送（mTLS）
start_customer_app() {
  # shellcheck disable=SC2046
  run --name "gekko13-customer-app$R" --network-alias customer-app $(app_labels customer-app) $(trace customer-app node) \
    -e SERVICE=customer-app -e SVID_DIR=/svid -e JWT_SVID_FILE=/svid/jwt_svid.token -e "TRUST_DOMAIN=$TD" \
    -e "ISSUER=$ISSUER" -e "APP_ORIGIN=$ORIGIN" -e "RP_ID=$RP_ID" -e LOGIN_ORIGIN=http://keycloak:8080 \
    -e AUTH_ORIGIN=https://auth:8443 -e AGENT_ORIGIN=https://sales-agent:8443 \
    -e DB_URL=postgres://postgres:5432/customer_app -e DB_USER=customer_app -e "DB_PASSWORD=$DB_CUSTOMER_APP" -e "STATE_KEY=$STATE_KEY" \
    -v "$HERE/run/svid/customer-app:/svid:ro" \
    "$IMAGE"
}

# 営業 AI エージェント（台本）。受け口は SVID の mTLS（8443）で、顧客のアプリの BFF だけが呼ぶ
start_sales_agent() {
  # shellcheck disable=SC2046
  run --name "gekko13-sales-agent$R" --network-alias sales-agent $(app_labels sales-agent) $(trace sales-agent node) \
    -e SERVICE=sales-agent -e SVID_DIR=/svid -e "TRUST_DOMAIN=$TD" \
    -e "LOGIN_ISSUER=$ISSUER" -e LOGIN_ORIGIN=http://keycloak:8080 \
    -e "GEKKO13_FAULT_CUT_STREAM=${GEKKO13_FAULT_CUT_STREAM:-}" \
    -e DB_URL=postgres://postgres:5432/sales_agent -e DB_USER=sales_agent -e "DB_PASSWORD=$DB_SALES_AGENT" -e "STATE_KEY=$AGENT_STATE_KEY" \
    -v "$HERE/run/svid/sales-agent:/svid:ro" \
    "$IMAGE"
}

# 事務サービス（Python）。受け口は SVID の mTLS（9443）で、営業 AI エージェントだけが呼ぶ。svid-helper と同じホストの利用者で読む
start_insurer_mcp() {
  # shellcheck disable=SC2046
  run --name "gekko13-insurer-mcp$R" --network-alias insurer-mcp --user "$(id -u):$(id -g)" $(app_labels insurer-mcp) $(trace insurer-mcp) \
    -e SVID_DIR=/svid -e "TRUST_DOMAIN=$TD" \
    -e "GEKKO13_FAULT_DROP_SUBMIT_REPLY=${GEKKO13_FAULT_DROP_SUBMIT_REPLY:-}" \
    -v "$HERE/run/svid/insurer-mcp:/svid:ro" \
    "$MCP_IMAGE"
}

# 保険会社のシステム（Java）。受け口は SVID の mTLS（9443）。直送は、顧客のアプリの 9443 へ送る
start_insurer_backend() {
  # shellcheck disable=SC2046
  run --name "gekko13-insurer-backend$R" --network-alias insurer-backend --memory 512m $(app_labels insurer-backend) $(trace insurer-backend java) \
    -e SVID_DIR=/svid -e "TRUST_DOMAIN=$TD" -e "RP_ID=$RP_ID" -e "WEBAUTHN_ORIGINS=$ORIGIN" \
    -e CUSTOMER_APP_URL=https://customer-app:9443 \
    -e DB_URL=jdbc:postgresql://postgres:5432/backend -e DB_USER=backend -e "DB_PASSWORD=$DB_BACKEND" \
    -e "OFFER_SIGNING_KEY=$(cat run/offer-key.pem)" \
    -v "$HERE/run/svid/insurer-backend:/svid:ro" \
    "$BACKEND_IMAGE"
}

# 監査サービス（Go）。入口から /audit の下を受ける。記録は、AWS では CloudWatch Logs から読むが、手元では docker のソケットから読む
# （書いた者は、ECS と同じ名前のラベルで決める）。docker のソケットを渡すのは手元だけで、AWS では渡さない
start_insurer_audit() {
  # shellcheck disable=SC2046
  run --name "gekko13-insurer-audit$R" --network-alias insurer-audit $(app_labels insurer-audit) $(trace insurer-audit) \
    --user "$(id -u):$(id -g)" --group-add "$(stat -c %g /var/run/docker.sock)" \
    -e SVID_DIR=/svid -e JWT_SVID_FILE=/svid/jwt_svid.token -e "TRUST_DOMAIN=$TD" \
    -e "ISSUER=$ISSUER" -e "PUBLIC_ORIGIN=$ORIGIN/audit" -e LOGIN_ORIGIN=http://keycloak:8080 \
    -e DB_URL=postgres://postgres:5432/audit -e DB_USER=audit -e "DB_PASSWORD=$DB_AUDIT" \
    -e RECORDS=docker -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -v "$HERE/run/svid/insurer-audit:/svid:ro" \
    "$AUDIT_IMAGE"
}

# 入口のリバースプロキシ（AWS では Lambda の Web Functions）。同じコードを、送り先を固定して動かす
start_entry() {
  run --name gekko13-entry \
    -e AWS_LAMBDA_HTTP_ENDPOINT=0.0.0.0:3000 -e ROUTES=/login=keycloak,/audit=insurer-audit,/=customer-app -e "PUBLIC_ORIGIN=$ORIGIN" \
    -e STATIC_TARGETS=keycloak=keycloak:8080,insurer-audit=insurer-audit:8080,customer-app=customer-app:8080 \
    -v "$HERE/../services/entry/src:/app/src:ro" -p 127.0.0.1:18000:3000 \
    node:24-alpine node /app/src/main.ts
}

# トレース（段 T）。AWS と同じく、入れたときだけ環境変数を渡す。collector は、ADOT をダイジェストで固定する
OTEL_IMAGE=public.ecr.aws/aws-observability/aws-otel-collector@sha256:955e240b27d7fd3c7995fd937db4b963975948eb553f656d8c37a564e5b5e07d
start_otel() {
  run --name gekko13-otel --network-alias otel --memory 128m -v "$HERE/otel/collector.yaml:/etc/otel/collector.yaml:ro" \
    "$OTEL_IMAGE" --config /etc/otel/collector.yaml
}
# trace <サービス> <node か java か その他>: コンテナに渡す環境変数
trace() {
  [ "${GEKKO13_TRACING:-}" = 1 ] || return 0
  printf "%s " -e OTEL_EXPORTER_OTLP_ENDPOINT=http://otel:4318 -e "OTEL_SERVICE_NAME=$1" -e OTEL_METRICS_EXPORTER=none -e OTEL_LOGS_EXPORTER=none
  case ${2:-} in
    node) printf "%s " -e NODE_OPTIONS=--import=/app/packages/tracing/src/register.ts ;;
    java) printf "%s " -e JAVA_TOOL_OPTIONS=-javaagent:/app/otel.jar -e OTEL_BSP_SCHEDULE_DELAY=2000 ;;
  esac
}

# サービスを指定されたら、そのサービスだけを入れ替える
if [ $# -gt 0 ]; then
  for s in "$@"; do
    case $s in
      keycloak) build_keycloak ;;
      auth) build_auth ;;
      customer-app | sales-agent) build_node ;;
      insurer-mcp) build_mcp ;;
      insurer-backend) build_backend ;;
      insurer-audit) build_audit ;;
      entry | otel) ;;
      *) echo "知らないサービス: $s" >&2; exit 1 ;;
    esac
    docker rm -f "gekko13-$s" >/dev/null 2>&1 || true
    for i in 2 3 4; do docker rm -f "gekko13-$s-$i" >/dev/null 2>&1 || true; done
    start "$s"
  done
  echo "入れ替えた: $*"
  exit 0
fi

build_node
build_auth
build_keycloak
build_mcp
build_backend
build_audit
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
docker volume create gekko13-agent-sockets >/dev/null

# 共有の保存先。データベースとロールは、AWS と同じ services/db-init/db-init.sql で作る
run --name gekko13-postgres --network-alias postgres -e "POSTGRES_PASSWORD=$DB_ADMIN" postgres:17
until docker exec gekko13-postgres pg_isready -q -h 127.0.0.1; do sleep 1; done
sleep 2
docker exec -i -e "PGPASSWORD=$DB_ADMIN" gekko13-postgres psql -q -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 \
  -v "spire_password=$DB_SPIRE" -v "keycloak_password=$DB_KEYCLOAK" -v "auth_password=$DB_AUTH" \
  -v "backend_password=$DB_BACKEND" -v "customer_app_password=$DB_CUSTOMER_APP" \
  -v "sales_agent_password=$DB_SALES_AGENT" -v "audit_password=$DB_AUDIT" -f - < ../services/db-init/db-init.sql >/dev/null

run --name gekko13-spire-server --network-alias spire-server \
  -v "$HERE/spire/server.conf:/etc/spire/server.conf:ro" \
  -v "$HERE/run/bundle-endpoint:/etc/spire/bundle-endpoint:ro" \
  "ghcr.io/spiffe/spire-server:$SPIRE" -config /etc/spire/server.conf

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

[ "${GEKKO13_TRACING:-}" != 1 ] || start_otel
start_keycloak
helper auth jwt
start_auth
helper customer-app jwt
start customer-app
for s in sales-agent insurer-mcp insurer-backend; do
  helper "$s"
  start "$s"
done
helper insurer-audit jwt
start insurer-audit
start_entry
echo "立ち上げた。ログインサーバーの起動に 1 分ほどかかる: $ORIGIN/"
