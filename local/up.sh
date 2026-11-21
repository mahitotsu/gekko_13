#!/usr/bin/env bash
# ローカルで、ECS on EC2 の 1 台の構成を docker run で模す（段 D の D1-a2-1）。秘密と SVID は local/run/ に置く（git に入れない）。
# - SVID を使うサービスは、ECS のタスクと同じく「app」と「svid-helper（spiffe-helper）」の 2 つのコンテナにする。
# - 各コンテナには、ECS のエージェントが付けるのと同じ名前のラベルを付ける。SPIRE の登録はこのラベルで選ぶ。
# - SVID は svid-helper がホストのディレクトリに書き、app は読むだけにする。app は agent のソケットを持たない。
# - ブラウザは、入口のリバースプロキシ（http://gekko13.localhost:18000）から、AWS の CloudFront と同じパスで使う。
#   /login はログインサーバー、それ以外は顧客のアプリ。Chromium は *.localhost をループバックに解決する。
# 手順: PostgreSQL → SPIRE の server → バンドルと join token → 登録 → agent → サービス → 入口。
# 使い方: local/up.sh（全部を立てる）。local/up.sh <サービス>...（立っている環境で、そのサービスのイメージを作り直して入れ替える。
#   サービスは keycloak、auth、customer-app、entry）
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
# 入口の origin。AWS ではディストリビューションのドメイン名
ORIGIN=http://gekko13.localhost:18000
RP_ID=gekko13.localhost
ISSUER=$ORIGIN/login/realms/insurer
# SVID を使うサービス
SERVICES=(auth customer-app)

mkdir -p run/bundle run/helper
for s in "${SERVICES[@]}"; do mkdir -p "run/svid/$s"; done

# 共有の保存先（段 D の D1-a1）の、管理者とサービスごとのパスワード。AWS では Aurora、ここでは PostgreSQL のコンテナ
if [ ! -f run/db.env ]; then
  printf 'DB_ADMIN=%s\nDB_SPIRE=%s\nDB_KEYCLOAK=%s\nDB_AUTH=%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" > run/db.env
fi
# shellcheck disable=SC1091
. run/db.env
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

build_node() { docker build -q -t "$IMAGE" -f ../Dockerfile "$(../scripts/stage-image.sh)" >/dev/null; }
build_auth() { docker buildx build -q --load -t "$AUTH_IMAGE" ../services/auth >/dev/null; }
build_keycloak() { docker buildx build -q --load -t "$KEYCLOAK_IMAGE" ../services/keycloak >/dev/null; }
run() { docker run -d --restart unless-stopped --network "$NET" --label gekko13=1 "$@" >/dev/null; }
srv() { docker exec gekko13-spire-server /opt/spire/bin/spire-server "$@"; }

# 各サービスの svid-helper。ホストの利用者で書く。シナリオの実行役が「盗まれた鍵」として読めるようにするため（検証でだけ）。
# auth と顧客のアプリは、ログインサーバーへのクライアント認証に示す JWT-SVID も書かせる（宛先は issuer）
helper() {
  local s=$1
  JWT_AUDIENCE=$ISSUER ../scripts/helper-conf.sh "run/helper/$s.conf"
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
  run --name gekko13-keycloak --network-alias keycloak --memory 1g \
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
  run --name gekko13-auth --network-alias auth --memory 512m $(app_labels auth) \
    -e SVID_DIR=/svid -e ISSUER=https://auth:8443 -e "TRUST_DOMAIN=$TD" \
    -e "LOGIN_ISSUER=$ISSUER" -e LOGIN_URL=http://keycloak:8080/login -e JWT_SVID_FILE=/svid/jwt_svid.token \
    -e DB_URL=jdbc:postgresql://postgres:5432/auth -e DB_USER=auth -e "DB_PASSWORD=$DB_AUTH" \
    -v "$HERE/run/svid/auth:/svid:ro" \
    -p 127.0.0.1:19443:8443 "$AUTH_IMAGE"
}

# 顧客のアプリ（画面の配信元と BFF）。8080 は入口から、9443 は保険会社のシステムからの直送（mTLS）
start_customer_app() {
  # shellcheck disable=SC2046
  run --name gekko13-customer-app --network-alias customer-app $(app_labels customer-app) \
    -e SERVICE=customer-app -e SVID_DIR=/svid -e JWT_SVID_FILE=/svid/jwt_svid.token -e "TRUST_DOMAIN=$TD" \
    -e "ISSUER=$ISSUER" -e "APP_ORIGIN=$ORIGIN" -e "RP_ID=$RP_ID" -e LOGIN_ORIGIN=http://keycloak:8080 \
    -e AUTH_ORIGIN=https://auth:8443 -e AGENT_ORIGIN=https://sales-agent:8443 \
    -v "$HERE/run/svid/customer-app:/svid:ro" \
    "$IMAGE"
}

# 入口のリバースプロキシ（AWS では Lambda の Web Functions）。同じコードを、送り先を固定して動かす
start_entry() {
  run --name gekko13-entry \
    -e AWS_LAMBDA_HTTP_ENDPOINT=0.0.0.0:3000 -e ROUTES=/login=keycloak,/=customer-app -e "PUBLIC_ORIGIN=$ORIGIN" \
    -e STATIC_TARGETS=keycloak=keycloak:8080,customer-app=customer-app:8080 \
    -v "$HERE/../services/entry/src:/app/src:ro" -p 127.0.0.1:18000:3000 \
    node:24-alpine node /app/src/main.ts
}

# サービスを指定されたら、そのサービスだけを入れ替える
if [ $# -gt 0 ]; then
  for s in "$@"; do
    case $s in
      keycloak) build_keycloak ;;
      auth) build_auth ;;
      customer-app) build_node ;;
      entry) ;;
      *) echo "知らないサービス: $s" >&2; exit 1 ;;
    esac
    docker rm -f "gekko13-$s" >/dev/null 2>&1 || true
    "start_${s//-/_}"
  done
  echo "入れ替えた: $*"
  exit 0
fi

build_node
build_auth
build_keycloak
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
docker volume create gekko13-agent-sockets >/dev/null

# 共有の保存先。データベースとロールは、AWS と同じ services/db-init/db-init.sql で作る
run --name gekko13-postgres --network-alias postgres -e "POSTGRES_PASSWORD=$DB_ADMIN" postgres:17
until docker exec gekko13-postgres pg_isready -q -h 127.0.0.1; do sleep 1; done
sleep 2
docker exec -i -e "PGPASSWORD=$DB_ADMIN" gekko13-postgres psql -q -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 \
  -v "spire_password=$DB_SPIRE" -v "keycloak_password=$DB_KEYCLOAK" -v "auth_password=$DB_AUTH" -f - < ../services/db-init/db-init.sql >/dev/null

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

start_keycloak
helper auth
start_auth
helper customer-app
start_customer_app
start_entry
echo "立ち上げた。ログインサーバーの起動に 1 分ほどかかる: $ORIGIN/"
