#!/usr/bin/env bash
# 事務サービス（Python）の試験と lint を、Docker の Python 3.12 で回す（ホストに Python の依存を入れない）。npm test が回す。
# 共通の例（packages/token-guard/vectors）も読むので、リポジトリ全体を渡す。キャッシュのファイルは作らない。
set -euo pipefail
cd "$(dirname "$0")/.."
docker volume create gekko13-pip >/dev/null
docker run --rm -v "$PWD:/w:ro" -v gekko13-pip:/root/.cache/pip -w /w/services/insurer-mcp \
  -e PYTHONDONTWRITEBYTECODE=1 -e RUFF_NO_CACHE=true python:3.12-slim sh -c '
    pip install -q --root-user-action=ignore --disable-pip-version-check -r requirements-dev.txt >/dev/null &&
    ruff check --no-cache insurer_mcp tests &&
    python -m pytest -q -p no:cacheprovider'
