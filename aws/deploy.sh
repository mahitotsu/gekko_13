#!/usr/bin/env bash
# AWS の段の資源を、決まった順番で作る。実行すると費用が出る（EC2 は動いている間、1 時間ごと）。
# 使い方: aws/deploy.sh <マネージドログインのドメインの接頭辞> [公開 IPv4 を付けるなら true]
# 順番: registry → イメージを写す → network → cognito → client の秘密を SSM へ → ecs。
# 秘密は画面にもファイルにも出さない。SSM の SecureString（AWS 管理のキー。月額なし）に直接入れる。
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN_PREFIX=${1:?マネージドログインのドメインの接頭辞を渡す}
PUBLIC_IPV4=${2:-false}
PREFIX=gekko13
REGION=${AWS_REGION:-ap-northeast-1}
SPIRE=1.15.3
HELPER=0.11.0
TAG=$(git rev-parse --short HEAD)$(git diff --quiet && git diff --cached --quiet || echo "-dirty")

cfn() { aws cloudformation deploy --region "$REGION" --no-fail-on-empty-changeset "$@"; }
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

cfn --stack-name "$PREFIX-registry" --template-file aws/registry.yaml
APP_REPO=$(out "$PREFIX-registry" AppRepositoryUri)
REGISTRY=${APP_REPO%%/*}
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

# SPIRE と spiffe-helper は、レジストリからレジストリへ写す（ローカルに取らない。arm64 も含む）
copy() { docker buildx imagetools inspect "$2" >/dev/null 2>&1 || docker buildx imagetools create --tag "$2" "$1"; }
copy "ghcr.io/spiffe/spire-server:$SPIRE" "$(out "$PREFIX-registry" SpireServerRepositoryUri):$SPIRE"
copy "ghcr.io/spiffe/spire-agent:$SPIRE" "$(out "$PREFIX-registry" SpireAgentRepositoryUri):$SPIRE"
copy "ghcr.io/spiffe/spiffe-helper:$HELPER" "$(out "$PREFIX-registry" SpiffeHelperRepositoryUri):$HELPER"

# アプリのイメージは arm64 で作る。Dockerfile に RUN がないので、エミュレーションは要らない
CTX=$(scripts/stage-image.sh)
docker buildx imagetools inspect "$APP_REPO:$TAG" >/dev/null 2>&1 || \
  docker buildx build --platform linux/arm64 -f Dockerfile -t "$APP_REPO:$TAG" --push "$CTX"

cfn --stack-name "$PREFIX-network" --template-file aws/network.yaml
cfn --stack-name "$PREFIX-cognito" --template-file aws/cognito.yaml --parameter-overrides "DomainPrefix=$DOMAIN_PREFIX"

POOL=$(out "$PREFIX-cognito" UserPoolId)
put_secret() {
  aws cognito-idp describe-user-pool-client --region "$REGION" --user-pool-id "$POOL" --client-id "$1" \
    --query UserPoolClient.ClientSecret --output text |
    aws ssm put-parameter --region "$REGION" --name "$2" --type SecureString --overwrite --value file:///dev/stdin >/dev/null
}
put_secret "$(out "$PREFIX-cognito" BffClientId)" "/$PREFIX/bff/client-secret"
put_secret "$(out "$PREFIX-cognito" TransferClientId)" "/$PREFIX/transfer/client-secret"

cfn --stack-name "$PREFIX-ecs" --template-file aws/ecs.yaml --capabilities CAPABILITY_IAM --parameter-overrides \
  "SubnetId=$(out "$PREFIX-network" SubnetId)" \
  "SecurityGroupId=$(out "$PREFIX-network" HostSecurityGroupId)" \
  "AssignPublicIpv4=$PUBLIC_IPV4" \
  "AppImage=$APP_REPO:$TAG" \
  "SpireServerImage=$(out "$PREFIX-registry" SpireServerRepositoryUri):$SPIRE" \
  "SpireAgentImage=$(out "$PREFIX-registry" SpireAgentRepositoryUri):$SPIRE" \
  "SpiffeHelperImage=$(out "$PREFIX-registry" SpiffeHelperRepositoryUri):$HELPER" \
  "Issuer=$(out "$PREFIX-cognito" Issuer)" \
  "TokenUrl=$(out "$PREFIX-cognito" TokenUrl)" \
  "AppClientId=$(out "$PREFIX-cognito" AppClientId)" \
  "BffClientId=$(out "$PREFIX-cognito" BffClientId)" \
  "TransferClientId=$(out "$PREFIX-cognito" TransferClientId)"

echo "作った。インスタンス: $(out "$PREFIX-ecs" InstanceId)。使い終わったら止める: aws ec2 stop-instances --instance-ids <ID>"
