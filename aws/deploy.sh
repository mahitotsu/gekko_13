#!/usr/bin/env bash
# AWS の段の資源を、決まった順番で作る。実行すると費用が出る（EC2 は動いている間、1 時間ごと）。
# 使い方: aws/deploy.sh
#   GEKKO13_AZS=2 を付けると、台を 2 つの AZ に置く。既定は 1。入口の ALB は、いつも 2 つの AZ のサブネットに置く。
#   GEKKO13_MAX_HOSTS で台の上限を（既定 2）、GEKKO13_EDGE_TASKS で edge-check のタスク数を（既定 2）変える。
#   GEKKO13_INSTANCE_TYPE で台の大きさを（既定 t4g.small）、GEKKO13_CONTAINER_INSIGHTS=enabled でメモリの測定を有効にする。
# 順番: registry → イメージ → network → ecs（基盤と ALB）→ apps（アプリ）→ edge（CloudFront の配信）。
# 段 D の D0 から、Cognito と第 1 部のアプリ（bff、transfer、ledger）は作らない。Cognito のスタックは、第 2 部の完成のときに消す。
# 秘密は画面にもファイルにも出さない。SSM の SecureString（AWS 管理のキー。月額なし）に直接入れる。
set -euo pipefail
cd "$(dirname "$0")/.."

# 段 C までの使い方（ドメインの接頭辞を渡す）を、黙って受け付けない
if [ $# -gt 0 ]; then echo "引数は要らない（Cognito は段 D の D0 から作らない）: $*" >&2; exit 2; fi
# サブネットはプライベートで IPv4 の経路がないので、公開 IPv4 は付けない（段 C の C-1b）
PUBLIC_IPV4=false
AZS=${GEKKO13_AZS:-1}
MAX_HOSTS=${GEKKO13_MAX_HOSTS:-2}
EDGE_TASKS=${GEKKO13_EDGE_TASKS:-2}
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

# CloudFront が VPC に作るグループ（最初の VPC origin でできる）。入口の ALB は、ここからだけ受ける
cfn --stack-name "$PREFIX-network" --template-file aws/network.yaml --parameter-overrides "CloudFrontVpcOriginSg=$(scripts/vpc-origin-sg.sh)"

# 認可サーバーの、利用者の代わりの窓口（user-standin）の秘密。なければ乱数で作る。値は画面にもファイルにも残さない
if ! aws ssm get-parameter --region "$REGION" --name "/$PREFIX/auth/standin-secret" >/dev/null 2>&1; then
  dir=$(umask 077 && mktemp -d -p /dev/shm gekko13-secret.XXXXXX)
  openssl rand -hex 16 | tr -d '\n' > "$dir/value"
  aws ssm put-parameter --region "$REGION" --name "/$PREFIX/auth/standin-secret" --type SecureString --value "file://$dir/value" >/dev/null
  rm -rf "$dir"
fi

# パスキーの RP ID は、入口の配信の名前。配信がまだなければ空にする（配信を作ったあとで、もう一度実行する）
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

# テンプレートは、日本語のコメントを含めると、直接送れる大きさ（51,200 バイト）を超えることがある。
# 送る前に、行頭のコメント（「# 」で始まる行）だけを除く。シバン（#!）は残す。S3 のバケットは使わない（docs/findings.md の 4-12）
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
strip() { grep -v -E '^[[:space:]]*# ' "aws/$1.yaml" > "$TMP/$1.yaml"; echo "$TMP/$1.yaml"; }

cfn --stack-name "$PREFIX-ecs" --template-file "$(strip ecs)" --capabilities CAPABILITY_IAM --parameter-overrides \
  "VpcId=$(out "$PREFIX-network" VpcId)" \
  "SubnetIds=$SUBNETS" \
  "SecurityGroupId=$(out "$PREFIX-network" HostSecurityGroupId)" \
  "AlbSubnetIds=$(out "$PREFIX-network" SubnetIds)" \
  "AlbSecurityGroupId=$(out "$PREFIX-network" AlbSecurityGroupId)" \
  "FileSystemId=$(out "$PREFIX-network" FileSystemId)" \
  "SpireServerAccessPointId=$(out "$PREFIX-network" SpireServerAccessPointId)" \
  "BundleAccessPointId=$(out "$PREFIX-network" BundleAccessPointId)" \
  "AssignPublicIpv4=$PUBLIC_IPV4" \
  "MaxInstances=$MAX_HOSTS" \
  "InstanceType=$INSTANCE_TYPE" \
  "ContainerInsights=$CONTAINER_INSIGHTS" \
  "AppImage=$(dualstack "$APP_REPO"):$TAG" \
  "SpireServerImage=$(dualstack "$(out "$PREFIX-registry" SpireServerRepositoryUri)"):$SPIRE" \
  "SpireAgentImage=$(dualstack "$(out "$PREFIX-registry" SpireAgentRepositoryUri)"):$SPIRE" \
  "SpiffeHelperImage=$(dualstack "$(out "$PREFIX-registry" SpiffeHelperRepositoryUri)"):$HELPER"

# 基盤のスタックから消えたサービス（D0 でアプリのスタックへ移した keycloak、auth、edge-check）は、しばらく DRAINING で残る。
# その間は同じ名前のサービスを作れない（推定）ので、アプリのスタックを作る前に、DRAINING が終わるのを待つ（上限 10 分）
for s in keycloak auth edge-check; do
  for _ in $(seq 60); do
    st=$(aws ecs describe-services --region "$REGION" --cluster "$PREFIX" --services "$s" --query 'services[0].status' --output text 2>/dev/null || echo MISSING)
    [ "$st" = DRAINING ] || break
    sleep 10
  done
done

cfn --stack-name "$PREFIX-apps" --template-file "$(strip apps)" --parameter-overrides \
  "VpcId=$(out "$PREFIX-network" VpcId)" \
  "ClusterName=$(out "$PREFIX-ecs" ClusterName)" \
  "CapacityProviderName=$(out "$PREFIX-ecs" CapacityProviderName)" \
  "NamespaceArn=$(out "$PREFIX-ecs" NamespaceArn)" \
  "ExecutionRoleArn=$(out "$PREFIX-ecs" ExecutionRoleArn)" \
  "LogGroupName=$(out "$PREFIX-ecs" LogGroupName)" \
  "ListenerArn=$(out "$PREFIX-ecs" ListenerArn)" \
  "AppImage=$(dualstack "$APP_REPO"):$TAG" \
  "AuthImage=$(dualstack "$AUTH_REPO"):$TAG" \
  "KeycloakImage=$(dualstack "$KEYCLOAK_REPO"):$TAG" \
  "SpiffeHelperImage=$(dualstack "$(out "$PREFIX-registry" SpiffeHelperRepositoryUri)"):$HELPER" \
  "EdgeTaskCount=$EDGE_TASKS" \
  "RpId=$(rp_id)"

# 入口の配信。送り先は ALB を指す VPC origin 1 つ。ALB は作り直さないので、台が入れ替わっても向け直しは要らない。
# 配信を初めて作ったときは、RP ID がまだ空なので、もう一度この手順を回す（keycloak のタスク数が 0 のままになる）
# aws/park.sh で止めていた配信は、ここで動かし直す（Parked=false。渡さないと、前の値の true が引き継がれる）
cfn --stack-name "$PREFIX-edge" --template-file aws/edge.yaml --parameter-overrides \
  "AlbArn=$(out "$PREFIX-ecs" LoadBalancerArn)" \
  "AlbDnsName=$(out "$PREFIX-ecs" LoadBalancerDnsName)" \
  "Parked=false"

echo "作った。入口: https://$(rp_id)/ 。使い終わったら aws/scale.sh down で、タスクと台を 0 にする"
