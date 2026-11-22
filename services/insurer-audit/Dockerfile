# syntax=docker/dockerfile:1
# 監査サービス（Go。段 D の D1-a2-3）のイメージ。ビルドする側の CPU（BUILDPLATFORM）で、動かす側の CPU 向けに作る（CGO_ENABLED=0）。
# arm64 のイメージも、エミュレーションなしで作れる。試験（go vet、go test）もここで回す。土台は、シェルのない distroless の static。
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY *.go ./
COPY templates templates
COPY assets assets
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go vet ./... && go test ./... && CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath -o /out/insurer-audit .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/insurer-audit /insurer-audit
# svid-helper は鍵を root のグループで 0640 にして書く。タスクの定義で、root でない利用者のまま、グループだけ root にして読む
USER 1000:0
ENTRYPOINT ["/insurer-audit"]
