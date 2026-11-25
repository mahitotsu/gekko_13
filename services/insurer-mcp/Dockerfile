# syntax=docker/dockerfile:1
# 事務サービス（Python、FastMCP）のイメージ（段 D の D1-a2-2）。
# 依存は、ビルドする側の CPU（BUILDPLATFORM）の段で、動かす側の CPU の wheel だけを取り込む（--only-binary）。arm64 のイメージも、
# エミュレーションなしで作れる。pip のキャッシュは BuildKit に置く。依存の層とコードの層を分ける。
FROM --platform=$BUILDPLATFORM python:3.12-slim AS deps
ARG TARGETARCH
COPY requirements.txt /req.txt
RUN --mount=type=cache,target=/root/.cache/pip case "$TARGETARCH" in amd64) a=x86_64 ;; arm64) a=aarch64 ;; *) echo "知らない CPU: $TARGETARCH" >&2; exit 2 ;; esac; \
    pip install -q --disable-pip-version-check --root-user-action=ignore --no-compile --target /out/site \
      --platform "manylinux2014_$a" --platform "manylinux_2_28_$a" --implementation cp --python-version 3.12 --only-binary=:all: -r /req.txt

FROM python:3.12-slim
WORKDIR /app
COPY --from=deps /out/site /app/site
COPY insurer_mcp /app/insurer_mcp
ENV PYTHONPATH=/app/site:/app PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 1000
CMD ["python", "-m", "insurer_mcp.main"]
