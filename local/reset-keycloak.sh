#!/usr/bin/env bash
# 手元のログインサーバーのデータベースを作り直し、レルムを取り込み直す（レルムの JSON を直したとき）。
# レルムは「すでにあれば取り込まない」ので、データベースを消してから Keycloak を入れ替える。手元の利用者の passkey も消える。
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
. run/db.env
docker rm -f gekko13-keycloak >/dev/null 2>&1 || true
docker exec -e "PGPASSWORD=$DB_ADMIN" gekko13-postgres psql -q -h 127.0.0.1 -U postgres \
  -c "DROP DATABASE IF EXISTS keycloak WITH (FORCE)" -c "CREATE DATABASE keycloak OWNER keycloak"
./up.sh keycloak
until curl -sf -o /dev/null http://127.0.0.1:18180/login/realms/insurer/.well-known/openid-configuration; do sleep 3; done
echo "ログインサーバーを作り直した"
