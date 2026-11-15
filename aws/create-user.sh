#!/usr/bin/env bash
# AWS の段: 検証用の利用者を 1 人作る。パスワードは画面で入力し、コマンドの引数に載せない。
# 使い方: aws/create-user.sh [利用者名（既定 demo-user）]
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=${1:-demo-user}
REGION=${AWS_REGION:-ap-northeast-1}
POOL=$(aws cloudformation describe-stacks --region "$REGION" --stack-name gekko13-cognito \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)

aws cognito-idp admin-get-user --region "$REGION" --user-pool-id "$POOL" --username "$NAME" >/dev/null 2>&1 ||
  aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$POOL" --username "$NAME" --message-action SUPPRESS >/dev/null

read -r -s -p "パスワード（16 文字以上、大文字・小文字・数字を含む）: " PW; echo
PW=$PW node -e 'process.stdout.write(JSON.stringify({UserPoolId:process.argv[1],Username:process.argv[2],Password:process.env.PW,Permanent:true}))' "$POOL" "$NAME" |
  aws cognito-idp admin-set-user-password --region "$REGION" --cli-input-json file:///dev/stdin
unset PW
echo "利用者 $NAME を作った。次は node scripts/aws-login.ts"
