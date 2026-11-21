# syntax=docker/dockerfile:1
# ログインサーバー（Keycloak）のイメージ。起動を速くするため、設定を kc.sh build で焼き込み、start --optimized で起こす。
# build の成果物は Java なので CPU の種類に依らない。build はビルドする側の CPU（BUILDPLATFORM）で動かし、
# 動かす側の CPU のイメージへ /opt/keycloak を写す。arm64 のイメージも、エミュレーションなしで作れる。
# 保存先は、共有の PostgreSQL（AWS では Aurora Serverless v2。段 D の D1-a1）。宛先、利用者、パスワードは、起動のときに環境変数で渡す。
# 複数のタスクで動かすので、キャッシュはタスクどうしで共有する（ispn）。相手の見つけ方は、データベースを使う jdbc-ping（Keycloak 26 の既定）。
# CloudFront の /login/* から届くので、パスの接頭辞を /login にする。
ARG KEYCLOAK=26.8.2
FROM --platform=$BUILDPLATFORM quay.io/keycloak/keycloak:${KEYCLOAK} AS build
ENV KC_DB=postgres KC_CACHE=ispn KC_CACHE_STACK=jdbc-ping KC_HEALTH_ENABLED=true KC_HTTP_RELATIVE_PATH=/login
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:${KEYCLOAK}
COPY --from=build --chown=1000:0 /opt/keycloak/ /opt/keycloak/
# 起動のたびに取り込むレルム。すでにあれば取り込まない（既定の IGNORE_EXISTING）。${RP_ID} などは、取り込みのときに環境変数で置き換わる
COPY --chown=1000:0 realm-gekko13.json /opt/keycloak/data/import/
# Aurora の証明書を確かめる CA（DB_CA_PEM。ECS が SSM から渡す）があれば、ファイルに書いてから起こす。JDBC の宛先（KC_DB_URL）が
# sslrootcert=/tmp/db-ca.pem を指す。手元の PostgreSQL では渡さない
ENTRYPOINT ["/bin/bash", "-c", "if [ -n \"${DB_CA_PEM:-}\" ]; then printf '%s\\n' \"$DB_CA_PEM\" > /tmp/db-ca.pem; fi; exec /opt/keycloak/bin/kc.sh \"$@\"", "kc"]
CMD ["start", "--optimized", "--import-realm"]
