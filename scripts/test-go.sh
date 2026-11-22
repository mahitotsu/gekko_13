#!/usr/bin/env bash
# 監査サービス（Go）の gofmt、vet、試験を、Docker の Go で回す（ホストに Go を入れない）。npm test が回す。
set -euo pipefail
cd "$(dirname "$0")/../services/insurer-audit"
docker volume create gekko13-go >/dev/null
docker run --rm -v "$PWD:/src:ro" -v gekko13-go:/m -w /src --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e GOCACHE=/m/build -e GOMODCACHE=/m/mod -e GOFLAGS=-mod=readonly golang:1.26 sh -c '
    test -z "$(gofmt -l .)" || { echo "gofmt を当てていない: $(gofmt -l .)" >&2; exit 1; }
    go vet ./... && go test ./...'
