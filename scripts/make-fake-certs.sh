#!/usr/bin/env bash
# シナリオ 3-e の偽の証明書を作る。どちらも SPIRE ではない認証局が署名する。
#   <出力先>/other-td/  別の信頼ドメイン（spiffe://evil.internal/svc/transfer）
#   <出力先>/same-id/   同じ SPIFFE ID（spiffe://gekko13.internal/svc/transfer）を名乗る
# 信頼されない使い捨ての証明書なので、検証用のイメージに入れてよい。
set -euo pipefail
OUT=${1:?出力先を渡す}

make() {
  local dir=$OUT/$1 id=$2
  mkdir -p "$dir"
  cd "$dir"
  printf 'subjectAltName=URI:%s\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth,serverAuth\n' "$id" > ext.cnf
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.pem -days 30 -subj /O=fake 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout key.pem -out leaf.csr -subj /O=fake 2>/dev/null
  openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out cert.pem -days 30 -extfile ext.cnf 2>/dev/null
  rm -f ext.cnf leaf.csr ca.key ca.srl
  cd - >/dev/null
}

make other-td spiffe://evil.internal/svc/transfer
make same-id spiffe://gekko13.internal/svc/transfer
