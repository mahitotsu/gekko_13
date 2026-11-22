# syntax=docker/dockerfile:1
# ログインサーバー（Keycloak）のイメージ。gekko_11 の insurer-login（取決めの範囲の処理と、A の発行の記録の拡張。gekko_11 の D-35、D-39）を、
# 製品に足す。起動を速くするため、設定を kc.sh build で焼き込み、start --optimized で起動する。
# 拡張の jar と、build の成果物は Java なので CPU の種類に依らない。どちらも、ビルドする側の CPU（BUILDPLATFORM）で動かし、
# 動かす側の CPU のイメージへ /opt/keycloak を写す。arm64 のイメージも、エミュレーションなしで作れる。
# 保存先は、共有の PostgreSQL（AWS では Aurora Serverless v2。段 D の D1-a1）。宛先、利用者、パスワードは、起動のときに環境変数で渡す。
# 複数のタスクで動かすので、キャッシュはタスクどうしで共有する（ispn）。相手の見つけ方は、データベースを使う jdbc-ping（Keycloak 26 の既定）。
# CloudFront の /login/* から届くので、パスの接頭辞を /login にする。
# SPIFFE の JWT-SVID でのクライアント認証（gekko_11 の D-38）は preview の機能で、既定で無効なので、build で有効にする。
ARG KEYCLOAK=26.8.2
FROM --platform=$BUILDPLATFORM maven:3.9-eclipse-temurin-21 AS extension
WORKDIR /src
COPY pom.xml .
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -q -B package

FROM --platform=$BUILDPLATFORM quay.io/keycloak/keycloak:${KEYCLOAK} AS build
COPY --from=extension /src/target/insurer-login-extension.jar /opt/keycloak/providers/
ENV KC_DB=postgres KC_CACHE=ispn KC_CACHE_STACK=jdbc-ping KC_HEALTH_ENABLED=true KC_HTTP_RELATIVE_PATH=/login \
    KC_FEATURES=spiffe,client-auth-federated
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:${KEYCLOAK}
COPY --from=build --chown=1000:0 /opt/keycloak/ /opt/keycloak/
# 起動のたびに取り込むレルム。すでにあれば取り込まない（既定の IGNORE_EXISTING）。${RP_ID} などは、取り込みのときに環境変数で置き換わる
COPY --chown=1000:0 realm/insurer.json /opt/keycloak/data/import/
# 画面は標準のものを引き継ぎ、passkey の登録で名前を尋ねないようにする（gekko_11 の D-42）
COPY --chown=1000:0 theme/insurer /opt/keycloak/themes/insurer
# 監査の担当のログインの画面。顧客の画面を引き継ぎ、色と見出しだけを替える（クライアント insurer-audit だけに使う）
COPY --chown=1000:0 theme/insurer-audit /opt/keycloak/themes/insurer-audit
# Aurora の証明書を確かめる CA（DB_CA_PEM）と、SPIRE の bundle endpoint の証明書（BUNDLE_CA_PEM）を、ECS が SSM から渡す。
# あれば、ファイルに書いてから起動する。JDBC の宛先（KC_DB_URL）が sslrootcert=/tmp/db-ca.pem を指し、
# KC_TRUSTSTORE_PATHS が /tmp/bundle-ca.pem を指す。手元では、ファイルをボリュームで渡す
ENTRYPOINT ["/bin/bash", "-c", "if [ -n \"${DB_CA_PEM:-}\" ]; then printf '%s\\n' \"$DB_CA_PEM\" > /tmp/db-ca.pem; fi; if [ -n \"${BUNDLE_CA_PEM:-}\" ]; then printf '%s\\n' \"$BUNDLE_CA_PEM\" > /tmp/bundle-ca.pem; fi; exec /opt/keycloak/bin/kc.sh \"$@\"", "kc"]
# 画面のスクリプトは、版が替わっても URL が変わらない。ブラウザに古いものを使わせないよう、キャッシュさせない（gekko_11 と同じ）
CMD ["start", "--optimized", "--import-realm", "--spi-theme--static-max-age=-1"]
