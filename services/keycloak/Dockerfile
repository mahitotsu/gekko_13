# syntax=docker/dockerfile:1
# ログインサーバー（Keycloak）のイメージ。起動を速くするため、設定を kc.sh build で焼き込み、start --optimized で起こす。
# build の成果物は Java なので CPU の種類に依らない。build はビルドする側の CPU（BUILDPLATFORM）で動かし、
# 動かす側の CPU のイメージへ /opt/keycloak を写す。arm64 のイメージも、エミュレーションなしで作れる。
# 保存先は dev-file（使い捨て。段 C の C-3。段 D で決める。docs/design-decisions.md）。
# CloudFront の /login/* から届くので、パスの接頭辞を /login にする。
ARG KEYCLOAK=26.8.2
FROM --platform=$BUILDPLATFORM quay.io/keycloak/keycloak:${KEYCLOAK} AS build
# 台をまたぐキャッシュは使わない（使い捨ての dev-file で、つなぐ相手がない）
ENV KC_DB=dev-file KC_CACHE=local KC_HEALTH_ENABLED=true KC_HTTP_RELATIVE_PATH=/login
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:${KEYCLOAK}
# dev-file は /opt/keycloak/data に書くので、動かす利用者（1000）の持ち物にする
COPY --from=build --chown=1000:0 /opt/keycloak/ /opt/keycloak/
# 起動のたびに取り込むレルム。${RP_ID} などは、取り込みのときに環境変数で置き換わる
COPY --chown=1000:0 realm-gekko13.json /opt/keycloak/data/import/
CMD ["start", "--optimized", "--import-realm"]
