#!/bin/sh
# spiffe-helper の設定を書く（段 D の D1-a2）。X.509-SVID に加え、JWT_AUDIENCE があれば、その宛先の JWT-SVID も書かせる。
# JWT-SVID は、ログインサーバーへのクライアント認証に示す（gekko_11 の D-38）。宛先は、ログインサーバーの issuer。
# AWS では、タスクの中で svid-helper より先に動くコンテナ（helper-config）が、タスクのボリュームに書く。手元では local/up.sh が書く。
# 使い方: helper-conf.sh <書き出す先>。環境変数 JWT_AUDIENCE（任意）
set -eu
OUT=${1:?書き出す先}
{
  echo 'agent_address         = "/run/spire/sockets/agent.sock"'
  echo 'cmd                   = ""'
  echo 'cert_dir              = "/svid"'
  echo 'svid_file_name        = "svid.pem"'
  echo 'svid_key_file_name    = "svid_key.pem"'
  echo 'svid_bundle_file_name = "svid_bundle.pem"'
  echo 'daemon_mode           = true'
  # svid-helper は root で動く。app は root でない利用者のまま、グループだけ root にして鍵を読む（docs/findings.md の 4-13）
  echo 'cert_file_mode        = 0644'
  echo 'key_file_mode         = 0640'
  if [ -n "${JWT_AUDIENCE:-}" ]; then
    echo "jwt_svids             = [{jwt_audience=\"$JWT_AUDIENCE\", jwt_svid_file_name=\"jwt_svid.token\"}]"
    echo 'jwt_svid_file_mode    = 0640'
  fi
} > "$OUT"
