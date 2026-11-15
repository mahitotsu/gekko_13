#!/usr/bin/env bash
# ローカルの検証の環境を消す。消すのは gekko13=1 のラベルを付けたコンテナ、gekko13 のネットワークとボリューム、local/run/（SVID と秘密）。
set -euo pipefail
cd "$(dirname "$0")"
ids=$(docker ps -aq --filter label=gekko13=1)
[ -n "$ids" ] && docker rm -f $ids >/dev/null
docker network rm gekko13 >/dev/null 2>&1 || true
docker volume rm gekko13-agent-sockets >/dev/null 2>&1 || true
rm -rf run
