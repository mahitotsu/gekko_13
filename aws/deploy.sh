#!/usr/bin/env bash
# AWS の段の資源を、決まった順番で作る。実行すると費用が出る（EC2 は動いている間、1 時間ごと）。
# 使い方: aws/deploy.sh <マネージドログインのドメインの接頭辞>
#   GEKKO13_AZS=2 を付けると、台を 2 つの AZ に置く（段 B）。既定は 1（段 A）。
#   GEKKO13_TASKS で bff、transfer、ledger のタスク数を、GEKKO13_MAX_HOSTS で台の上限を変える（既定 1 と 2）。
#   GEKKO13_INSTANCE_TYPE で台の大きさを（既定 t4g.small）、GEKKO13_CONTAINER_INSIGHTS=enabled でメモリの測定を有効にする（段 C の C-3）。
# 順番: registry → イメージを写す → network → cognito → client の秘密を SSM へ → ecs。
# 秘密は画面にもファイルにも出さない。SSM の SecureString（AWS 管理のキー。月額なし）に直接入れる。
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN_PREFIX=${1:?マネージドログインのドメインの接頭辞を渡す}
# サブネットはプライベートで IPv4 の経路がないので、公開 IPv4 を付けても使えない（段 C の C-1b）
if [ "${2:-false}" != false ]; then echo "公開 IPv4 は付けられない。サブネットに IPv4 の経路がない（docs/design-decisions.md）" >&2; exit 1; fi
PUBLIC_IPV4=false
AZS=${GEKKO13_AZS:-1}
TASKS=${GEKKO13_TASKS:-1}
MAX_HOSTS=${GEKKO13_MAX_HOSTS:-2}
INSTANCE_TYPE=${GEKKO13_INSTANCE_TYPE:-t4g.small}
CONTAINER_INSIGHTS=${GEKKO13_CONTAINER_INSIGHTS:-disabled}
PREFIX=gekko13
REGION=${AWS_REGION:-ap-northeast-1}
SPIRE=1.15.3
HELPER=0.11.0
TAG=$(git rev-parse --short HEAD)$(git diff --quiet && git diff --cached --quiet || echo "-dirty")

# CloudFormation は ASCII 以外の文字を「?」に置き換える。送る前に止める
scripts/check-templates.sh

cfn() { aws cloudformation deploy --region "$REGION" --no-fail-on-empty-changeset "$@"; }
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
# ホストは、IPv6 で届くデュアルスタックの名前からイメージを取る（既定の dkr.ecr の名前は IPv4 だけ。docs/findings.md）
dualstack() { sed -E 's/\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com/.dkr-ecr.\1.on.aws/' <<<"$1"; }

cfn --stack-name "$PREFIX-registry" --template-file aws/registry.yaml
APP_REPO=$(out "$PREFIX-registry" AppRepositoryUri)
REGISTRY=${APP_REPO%%/*}
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

# SPIRE と spiffe-helper は、レジストリからレジストリへ写す（ローカルに取らない。arm64 も含む）
copy() { docker buildx imagetools inspect "$2" >/dev/null 2>&1 || docker buildx imagetools create --tag "$2" "$1"; }
copy "ghcr.io/spiffe/spire-server:$SPIRE" "$(out "$PREFIX-registry" SpireServerRepositoryUri):$SPIRE"
copy "ghcr.io/spiffe/spire-agent:$SPIRE" "$(out "$PREFIX-registry" SpireAgentRepositoryUri):$SPIRE"
copy "ghcr.io/spiffe/spiffe-helper:$HELPER" "$(out "$PREFIX-registry" SpiffeHelperRepositoryUri):$HELPER"

# アプリのイメージは arm64 で作る。Dockerfile に RUN がないので、エミュレーションは要らない。
# spire-server の CLI を写すので、SPIRE の版を揃える
CTX=$(scripts/stage-image.sh)
docker buildx imagetools inspect "$APP_REPO:$TAG" >/dev/null 2>&1 || \
  docker buildx build --platform linux/arm64 --build-arg "SPIRE=$SPIRE" -f Dockerfile -t "$APP_REPO:$TAG" --push "$CTX"

# 認可サーバーとログインサーバー（Java）。どちらも、ビルドの段はビルドする側の CPU で動くので、エミュレーションは要らない
AUTH_REPO=$(out "$PREFIX-registry" AuthRepositoryUri)
KEYCLOAK_REPO=$(out "$PREFIX-registry" KeycloakRepositoryUri)
docker buildx imagetools inspect "$AUTH_REPO:$TAG" >/dev/null 2>&1 || \
  docker buildx build --platform linux/arm64 -t "$AUTH_REPO:$TAG" --push services/auth
docker buildx imagetools inspect "$KEYCLOAK_REPO:$TAG" >/dev/null 2>&1 || \
  docker buildx build --platform linux/arm64 -t "$KEYCLOAK_REPO:$TAG" --push services/keycloak

# CloudFront が VPC に作るグループ（最初の VPC origin でできる）。台は、ここからだけ入口のポートを受ける。
# まだなければ空で渡し、aws/edge-point.sh が VPC origin を作ったあとで渡し直す
cfn --stack-name "$PREFIX-network" --template-file aws/network.yaml --parameter-overrides "CloudFrontVpcOriginSg=$(scripts/vpc-origin-sg.sh)"
cfn --stack-name "$PREFIX-cognito" --template-file aws/cognito.yaml --parameter-overrides "DomainPrefix=$DOMAIN_PREFIX"

POOL=$(out "$PREFIX-cognito" UserPoolId)
# --output text は値の末尾に改行を付ける。そのまま入れると、Cognito が invalid_client を返す（docs/findings.md）。
# 改行を取り、メモリの上（/dev/shm）の、本人だけが読める一時ファイルから入れて、すぐに消す
put_secret() {
  local dir
  dir=$(umask 077 && mktemp -d -p /dev/shm gekko13-secret.XXXXXX)
  aws cognito-idp describe-user-pool-client --region "$REGION" --user-pool-id "$POOL" --client-id "$1" \
    --query UserPoolClient.ClientSecret --output text | tr -d '\n' > "$dir/value"
  aws ssm put-parameter --region "$REGION" --name "$2" --type SecureString --overwrite --value "file://$dir/value" >/dev/null
  rm -rf "$dir"
}
put_secret "$(out "$PREFIX-cognito" BffClientId)" "/$PREFIX/bff/client-secret"
put_secret "$(out "$PREFIX-cognito" TransferClientId)" "/$PREFIX/transfer/client-secret"
# 認可サーバーの、利用者の代わりの窓口（user-standin）の秘密。なければ乱数で作る。値は画面にもファイルにも残さない
if ! aws ssm get-parameter --region "$REGION" --name "/$PREFIX/auth/standin-secret" >/dev/null 2>&1; then
  dir=$(umask 077 && mktemp -d -p /dev/shm gekko13-secret.XXXXXX)
  openssl rand -hex 16 | tr -d '\n' > "$dir/value"
  aws ssm put-parameter --region "$REGION" --name "/$PREFIX/auth/standin-secret" --type SecureString --value "file://$dir/value" >/dev/null
  rm -rf "$dir"
fi
# プローブの動かし方。aws/run-scenarios.sh が書き換える。なければ作る（秘密ではない）
aws ssm get-parameter --region "$REGION" --name "/$PREFIX/probe/mode" >/dev/null 2>&1 || \
  aws ssm put-parameter --region "$REGION" --name "/$PREFIX/probe/mode" --type String --value scenarios >/dev/null

# パスキーの RP ID は、入口の配信の名前。配信がまだなければ空にする（aws/edge-point.sh が作ったあとで、もう一度実行する）
rp_id() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$PREFIX-edge" \
    --query "Stacks[0].Outputs[?OutputKey=='DomainName'].OutputValue" --output text 2>/dev/null || true
}

if [ "$AZS" = 2 ]; then
  SUBNETS=$(out "$PREFIX-network" SubnetIds)
else
  SUBNETS=$(out "$PREFIX-network" SubnetId)
fi

# scale.sh down のあとは、spire-server のタスク数が 0 のまま残る。テンプレートの値（1）は変わらないので、
# スタックの更新では戻らず、server のいないサービスが安定しないまま更新が待ち続ける。更新の前に 1 に戻す。
# 置き方の制約（B-4 の試験が付ける）が残っていれば、外す。CloudFormation は、テンプレートに書いていない制約を戻さないので、
# 残っていると、制約に合う台がないときに server を置けず、更新が待ち続ける（docs/findings.md）
if aws ecs describe-services --region "$REGION" --cluster "$PREFIX" --services spire-server \
  --query 'services[?status==`ACTIVE`].serviceName' --output text 2>/dev/null | grep -q spire-server; then
  aws ecs update-service --region "$REGION" --cluster "$PREFIX" --service spire-server --desired-count 1 \
    --placement-constraints '[]' >/dev/null
fi

cfn --stack-name "$PREFIX-ecs" --template-file aws/ecs.yaml --capabilities CAPABILITY_IAM --parameter-overrides \
  "VpcId=$(out "$PREFIX-network" VpcId)" \
  "SubnetIds=$SUBNETS" \
  "SecurityGroupId=$(out "$PREFIX-network" HostSecurityGroupId)" \
  "FileSystemId=$(out "$PREFIX-network" FileSystemId)" \
  "SpireServerAccessPointId=$(out "$PREFIX-network" SpireServerAccessPointId)" \
  "BundleAccessPointId=$(out "$PREFIX-network" BundleAccessPointId)" \
  "AssignPublicIpv4=$PUBLIC_IPV4" \
  "TaskCount=$TASKS" \
  "MaxInstances=$MAX_HOSTS" \
  "InstanceType=$INSTANCE_TYPE" \
  "ContainerInsights=$CONTAINER_INSIGHTS" \
  "AuthImage=$(dualstack "$AUTH_REPO"):$TAG" \
  "KeycloakImage=$(dualstack "$KEYCLOAK_REPO"):$TAG" \
  "AppImage=$(dualstack "$APP_REPO"):$TAG" \
  "SpireServerImage=$(dualstack "$(out "$PREFIX-registry" SpireServerRepositoryUri)"):$SPIRE" \
  "SpireAgentImage=$(dualstack "$(out "$PREFIX-registry" SpireAgentRepositoryUri)"):$SPIRE" \
  "SpiffeHelperImage=$(dualstack "$(out "$PREFIX-registry" SpiffeHelperRepositoryUri)"):$HELPER" \
  "Issuer=$(out "$PREFIX-cognito" Issuer)" \
  "TokenUrl=$(out "$PREFIX-cognito" TokenUrl)" \
  "AppClientId=$(out "$PREFIX-cognito" AppClientId)" \
  "BffClientId=$(out "$PREFIX-cognito" BffClientId)" \
  "TransferClientId=$(out "$PREFIX-cognito" TransferClientId)" \
  "RpId=$(rp_id)"

echo "作った。使い終わったら aws/scale.sh down で、タスクと台を 0 にする"
