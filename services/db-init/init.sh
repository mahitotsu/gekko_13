#!/bin/sh
# SPIRE server のタスクで、server より先に動いて終わる（段 D の D1-a1。aws/ecs.yaml の db-init）。
# 1. ECS が SSM から渡したファイルの中身を、タスクの中のボリュームに書く。Aurora の CA（DB_CA_PEM）と、SPIRE のルート CA の証明書と鍵
#    （SPIRE_ROOT_CERT、SPIRE_ROOT_KEY。UpstreamAuthority の disk が読む）。
# 2. Aurora が止まっていれば、つなぎに行くと再開するので、つながるまで待つ（上限 3 分）。
# 3. 管理者で db-init.sql を流し、サービスごとのデータベースとロールを作る。何度流しても同じ結果になる。
# 環境変数: DB_HOST、DB_ADMIN_USER、DB_ADMIN_PASSWORD、DB_SPIRE_PASSWORD、DB_KEYCLOAK_PASSWORD、DB_AUTH_PASSWORD、
#   DB_CA_PEM、SPIRE_ROOT_CERT、SPIRE_ROOT_KEY。書き出す先: /dbca/ca.pem、/spire-ca/root.crt、/spire-ca/root.key
set -eu
umask 077
printf '%s\n' "${DB_CA_PEM:?}" > /dbca/ca.pem
printf '%s\n' "${SPIRE_ROOT_CERT:?}" > /spire-ca/root.crt
printf '%s\n' "${SPIRE_ROOT_KEY:?}" > /spire-ca/root.key
# spire-server のコンテナ（root で動く）が読む。CA の証明書は、ほかのコンテナも読めるようにする
chmod 0644 /dbca/ca.pem /spire-ca/root.crt

CONN="host=${DB_HOST:?} port=5432 dbname=postgres user=${DB_ADMIN_USER:?} sslmode=verify-full sslrootcert=/dbca/ca.pem connect_timeout=10"
export PGPASSWORD="${DB_ADMIN_PASSWORD:?}"
i=0
until psql "$CONN" -Atqc 'select 1' >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -le 36 ] || { echo "db-init: Aurora に 3 分つながらなかった" >&2; psql "$CONN" -Atqc 'select 1' >&2 || true; exit 1; }
  echo "db-init: Aurora を待つ ($i)"
  sleep 5
done
psql "$CONN" -q -v ON_ERROR_STOP=1 \
  -v "spire_password=${DB_SPIRE_PASSWORD:?}" -v "keycloak_password=${DB_KEYCLOAK_PASSWORD:?}" -v "auth_password=${DB_AUTH_PASSWORD:?}" \
  -f /db-init.sql >/dev/null
echo "db-init: done"
