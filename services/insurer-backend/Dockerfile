# syntax=docker/dockerfile:1
# 保険会社のシステム（Spring Boot）のイメージ（段 D の D1-a2-2）。auth と同じ作り。
# JAR は CPU の種類に依らないので、Maven はビルドする側の CPU（BUILDPLATFORM）で動かす。arm64 のイメージも、エミュレーションなしで作れる。
# 試験（mvn test）もここで回す。トークンの確かめの共通の例は、名前つきの文脈 vectors（packages/token-guard/vectors）から写す。
# ビルドのとき: docker buildx build --build-context vectors=packages/token-guard/vectors services/insurer-backend
FROM --platform=$BUILDPLATFORM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
COPY src ./src
COPY --from=vectors service-token.json vectors/
RUN --mount=type=cache,target=/root/.m2 mvn -q -B package

FROM eclipse-temurin:21-jre
COPY --from=build /src/target/insurer-backend.jar /app/insurer-backend.jar
# トレースの計装（段 T）。タスクの定義が JAVA_TOOL_OPTIONS で指したときだけ読む。/app ができたあとに足す（先に足すと、--chmod が /app にも当たる）
ADD --chmod=0644 --checksum=sha256:da44154cea128257779c8a782b9651fd7c0c6aa177cd3810f9a867ac8509555d https://repo1.maven.org/maven2/io/opentelemetry/javaagent/opentelemetry-javaagent/2.34.0/opentelemetry-javaagent-2.34.0.jar /app/otel.jar
USER 1000
# Aurora の証明書を確かめる CA（DB_CA_PEM。ECS が SSM から渡す）があれば、ファイルに書く。JDBC の宛先（DB_URL）が /tmp/db-ca.pem を指す。
# spiffe-helper が SVID を書くまで待ってから起動する。SSL バンドルは、起動のときにファイルがないと失敗するため
ENTRYPOINT ["sh", "-c", "if [ -n \"${DB_CA_PEM:-}\" ]; then printf '%s\\n' \"$DB_CA_PEM\" > /tmp/db-ca.pem; fi; until [ -s \"$SVID_DIR/svid.pem\" ] && [ -s \"$SVID_DIR/svid_bundle.pem\" ]; do sleep 1; done; exec java -XX:MaxRAMPercentage=75 -jar /app/insurer-backend.jar"]
