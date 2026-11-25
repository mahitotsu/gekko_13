#!/usr/bin/env bash
# AWS の段の資源を、決まった順番で作る。実行すると費用が出る（EC2 は動いている間、1 時間ごと）。
# 使い方: aws/deploy.sh
#   GEKKO13_AZS=2 を付けると、インスタンスを 2 つの AZ に置く。既定は 1。入口のリバースプロキシの ENI は、いつも 2 つの AZ のサブネットに置く。
#   GEKKO13_MAX_HOSTS でインスタンスの上限を（既定 4。タスクのオートスケーリングで増える分）変える。
#   GEKKO13_INSTANCE_TYPES でインスタンスの種類を（スポットの候補。ちょうど 4 つ。既定は ecs.yaml の InstanceTypes）、
#   GEKKO13_CONTAINER_INSIGHTS=enabled でメモリの測定を有効にする。インスタンスは全部スポットで起動する。
#   GEKKO13_AUTOSCALING=true で、Keycloak と auth のタスクのオートスケーリング（2〜4）を作る。既定は作らず、どのサービスも 2 タスク
#   （段 D の D1-a3。判断 56。性能を確かめるときに使う。アラームの固定費がかかる）。
#   GEKKO13_TRACING=false で、トレース（collector と計装）を外す。既定は入れる（判断 63）。
# 順番: registry → イメージとリバースプロキシの zip → network → db（共有の Aurora）→ ecs（基盤）→ apps（Keycloak と auth）→ flow（主の流れのサービス）→ entry（入口のリバースプロキシ）→ edge（CloudFront のディストリビューション）。
# 秘密は画面にもファイルにも出さない。SSM の SecureString（AWS 管理のキー。月額なし）に直接入れる。
set -euo pipefail
cd "$(dirname "$0")/.."

# 段 C までの使い方（ドメインの接頭辞を渡す）を、黙って受け付けない
if [ $# -gt 0 ]; then echo "引数は要らない: $*" >&2; exit 2; fi
# サブネットはプライベートで IPv4 の経路がないので、公開 IPv4 は付けない（段 C の C-1b）
PUBLIC_IPV4=false
AZS=${GEKKO13_AZS:-1}
MAX_HOSTS=${GEKKO13_MAX_HOSTS:-4}
INSTANCE_TYPES=${GEKKO13_INSTANCE_TYPES:-t4g.medium,c6g.large,c7g.large,t4g.large}
[ "$(tr ',' '\n' <<<"$INSTANCE_TYPES" | grep -c .)" = 4 ] || { echo "GEKKO13_INSTANCE_TYPES は、ちょうど 4 つの種類をカンマで並べる: $INSTANCE_TYPES" >&2; exit 2; }
CONTAINER_INSIGHTS=${GEKKO13_CONTAINER_INSIGHTS:-disabled}
# shellcheck source=aws/lib.sh
. aws/lib.sh
SPIRE=1.15.3
HELPER=0.11.0
# トレースの collector（ADOT）。タグは版で、中身はダイジェストで固定する。
# public.ecr.aws の匿名の取得は毎秒 1 回までで、429 で断られた。IAM で認証してから写す（findings 5-38）
OTEL=v0.51.0
OTEL_SOURCE=public.ecr.aws/aws-observability/aws-otel-collector@sha256:955e240b27d7fd3c7995fd937db4b963975948eb553f656d8c37a564e5b5e07d
TRACING=${GEKKO13_TRACING:-true}
case $TRACING in true | false) ;; *) echo "GEKKO13_TRACING は true か false: $TRACING" >&2; exit 2 ;; esac
# イメージのタグは、イメージごとの材料の、コミットした中身から作る（scripts/image-tag.sh）。材料が同じなら作り直さず、
# タスクも入れ替わらない。材料にコミットしていない変更があれば、ここで止まる。どのコミットから作ったかは、ラベルに残す
REVISION=$(git rev-parse HEAD)
APP_TAG=$(scripts/image-tag.sh "SPIRE=$SPIRE" Dockerfile .dockerignore package.json package-lock.json packages services/customer-app services/sales-agent \
  scripts/spire-registrar.sh scripts/helper-conf.sh ':!**/test/**')
AUTH_TAG=$(scripts/image-tag.sh "" services/auth)
KEYCLOAK_TAG=$(scripts/image-tag.sh "" services/keycloak)
DB_INIT_TAG=$(scripts/image-tag.sh "" services/db-init)
# 事務サービス（Python）と保険会社のシステム（Java。試験は共通の例も読む）。段 D の D1-a2-2
MCP_TAG=$(scripts/image-tag.sh "" services/insurer-mcp ':!services/insurer-mcp/tests/**')
BACKEND_TAG=$(scripts/image-tag.sh "" services/insurer-backend packages/token-guard/vectors)
# 監査サービス（Go）。段 D の D1-a2-3
AUDIT_TAG=$(scripts/image-tag.sh "" services/insurer-audit)
LABEL="org.opencontainers.image.revision=$REVISION"

# CloudFormation は ASCII 以外の文字を「?」に置き換える。送る前に止める
scripts/check-templates.sh

# 渡すタスク数の元（Running）を決める。スタックがそろわないか、実際のタスク数と合わなければ、何も作らずに止める（findings 5-21、5-27）。
# 0 台のときは false のまま送る。新しいタスク定義は登録され、次の aws/scale.sh up で起きる
RUNNING=$(deploy_running)
# 新しいサービスで DesiredCount を書かないと、1 になる（CloudFormation の資料）。初めてのときは、オートスケーリングなしで作る
if [ "${GEKKO13_AUTOSCALING:-false}" = true ] && [ "$(running_of "$PREFIX-apps")" = absent ]; then
  echo "初めてのデプロイでは GEKKO13_AUTOSCALING=true を付けない（作ったあとで付ける）" >&2; exit 2
fi
for s in $RUN_STACKS; do
  # running_of を代入で受け、AWS の呼び出しが失敗したときも止める
  CUR=$(running_of "$s")
  [ "$CUR" = absent ] || check_ready "$s"
done

cfn() { aws cloudformation deploy --region "$REGION" --no-fail-on-empty-changeset "$@"; }
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
if ! docker buildx imagetools inspect "$(out "$PREFIX-registry" OtelCollectorRepositoryUri):$OTEL" >/dev/null 2>&1; then
  aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws >/dev/null
fi
copy "$OTEL_SOURCE" "$(out "$PREFIX-registry" OtelCollectorRepositoryUri):$OTEL"

# アプリのイメージは arm64 で作る。RUN はビルドする側の CPU で動くので、エミュレーションは要らない。
# spire-server の CLI を写すので、SPIRE の版を揃える
docker buildx imagetools inspect "$APP_REPO:$APP_TAG" >/dev/null 2>&1 || \
  docker buildx build --platform linux/arm64 --build-arg "SPIRE=$SPIRE" --label "$LABEL" -f Dockerfile -t "$APP_REPO:$APP_TAG" --push .

# 認可サーバーとログインサーバー（Java）。どちらも、ビルドの段はビルドする側の CPU で動くので、エミュレーションは要らない
AUTH_REPO=$(out "$PREFIX-registry" AuthRepositoryUri)
KEYCLOAK_REPO=$(out "$PREFIX-registry" KeycloakRepositoryUri)
docker buildx imagetools inspect "$AUTH_REPO:$AUTH_TAG" >/dev/null 2>&1 || \
  docker buildx build --platform linux/arm64 --label "$LABEL" -t "$AUTH_REPO:$AUTH_TAG" --push services/auth
docker buildx imagetools inspect "$KEYCLOAK_REPO:$KEYCLOAK_TAG" >/dev/null 2>&1 || \
  docker buildx build --platform linux/arm64 --label "$LABEL" -t "$KEYCLOAK_REPO:$KEYCLOAK_TAG" --push services/keycloak
# Aurora にデータベースとロールを作るコンテナ（SPIRE server のタスクで、server より先に動く。RUN がないので、エミュレーションは要らない）
DB_INIT_REPO=$(out "$PREFIX-registry" DbInitRepositoryUri)
docker buildx imagetools inspect "$DB_INIT_REPO:$DB_INIT_TAG" >/dev/null 2>&1 || \
  docker buildx build --platform linux/arm64 --label "$LABEL" -t "$DB_INIT_REPO:$DB_INIT_TAG" --push services/db-init

# 事務サービス（Python）は、ビルドする側の CPU の段で、arm64 の wheel だけを取り込む（エミュレーションは要らない）
MCP_REPO=$(out "$PREFIX-registry" InsurerMcpRepositoryUri)
docker buildx imagetools inspect "$MCP_REPO:$MCP_TAG" >/dev/null 2>&1 || \
  docker buildx build --platform linux/arm64 --label "$LABEL" -t "$MCP_REPO:$MCP_TAG" --push services/insurer-mcp
# 保険会社のシステム（Java）。ビルドの段はビルドする側の CPU で動く。試験の共通の例を、名前つきの文脈で渡す
BACKEND_REPO=$(out "$PREFIX-registry" InsurerBackendRepositoryUri)
docker buildx imagetools inspect "$BACKEND_REPO:$BACKEND_TAG" >/dev/null 2>&1 || \
  docker buildx build --platform linux/arm64 --label "$LABEL" --build-context vectors=packages/token-guard/vectors \
    -t "$BACKEND_REPO:$BACKEND_TAG" --push services/insurer-backend

# 監査サービス（Go）。ビルドの段はビルドする側の CPU で、arm64 向けに作る（エミュレーションは要らない）
AUDIT_REPO=$(out "$PREFIX-registry" InsurerAuditRepositoryUri)
docker buildx imagetools inspect "$AUDIT_REPO:$AUDIT_TAG" >/dev/null 2>&1 || \
  docker buildx build --platform linux/arm64 --label "$LABEL" -t "$AUDIT_REPO:$AUDIT_TAG" --push services/insurer-audit

# 入口のリバースプロキシ（Web Functions）の zip。キーは中身の SHA-256 にし、同じ中身なら置き直さない（リビジョンも作り直さない）
ENTRY_BUCKET=$(out "$PREFIX-registry" EntryCodeBucketName)
ENTRY_ZIP=$(scripts/stage-entry.sh)
ENTRY_KEY="entry/$(sha256sum "$ENTRY_ZIP" | cut -c1-64).zip"
ENTRY_VERSION=$(aws s3api head-object --region "$REGION" --bucket "$ENTRY_BUCKET" --key "$ENTRY_KEY" --query VersionId --output text 2>/dev/null || true)
if [ -z "$ENTRY_VERSION" ] || [ "$ENTRY_VERSION" = None ]; then
  ENTRY_VERSION=$(aws s3api put-object --region "$REGION" --bucket "$ENTRY_BUCKET" --key "$ENTRY_KEY" --body "$ENTRY_ZIP" --query VersionId --output text)
fi

cfn --stack-name "$PREFIX-network" --template-file aws/network.yaml


# 秘密を作って SSM の SecureString に置く。すでにあれば作らない（作り直すと、使っている側とずれる）。値は画面にもファイルにも残さない。
# 第 2 引数は、値を作るコマンド（標準出力に値を出す）
SECRET_DIR=$(umask 077 && mktemp -d -p /dev/shm gekko13-secret.XXXXXX)
trap 'rm -rf "${SECRET_DIR:?}"' EXIT
has_param() { aws ssm get-parameter --region "$REGION" --name "$1" >/dev/null 2>&1; }
put_secret() {
  has_param "$1" && return 0
  "${@:2}" > "$SECRET_DIR/value"
  aws ssm put-parameter --region "$REGION" --name "$1" --type SecureString --value "file://$SECRET_DIR/value" >/dev/null
  rm -f "$SECRET_DIR/value"
  echo "SSM に $1 を作った"
}
hex16() { openssl rand -hex 16 | tr -d '\n'; }
hex24() { openssl rand -hex 24 | tr -d '\n'; }
# 共有の Aurora（段 D の D1-a1）の管理者と、サービスごとのパスワード
put_secret "/$PREFIX/db/master-password" hex24
for r in spire keycloak auth backend customer-app sales-agent audit; do put_secret "/$PREFIX/db/$r-password" hex24; done
# auth のトークンの発行の鍵（RSA、PKCS#8 の PEM）。複数のタスクが同じ鍵で出し、確かめる
put_secret "/$PREFIX/auth/signing-key" openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048
# 保険会社のシステムの提示の鍵（P-256。段 D の D1-a3、判断 53）。秘密鍵（PKCS#8）と公開鍵（X.509）の PEM を並べて置く
# （JDK だけでは、EC の秘密鍵から公開鍵を導けないため）。複数のタスクが同じ鍵で署名し、確かめる
ec_pair() { local k; k=$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256); printf '%s\n' "$k"; printf '%s\n' "$k" | openssl pkey -pubout; }
put_secret "/$PREFIX/backend/offer-key" ec_pair
# 顧客のアプリのセッションを、共有の Aurora に置くときの暗号鍵（AES-256、16 進で 32 バイト。段 D の D1-a3、判断 54）
hex32() { openssl rand -hex 32 | tr -d '\n'; }
put_secret "/$PREFIX/customer-app/state-key" hex32
# 営業 AI エージェントの会話の暗号鍵（判断 55）。サービスごとに分ける
put_secret "/$PREFIX/sales-agent/state-key" hex32
# SPIRE のルート CA（ECDSA P-256、5 年）。全部の server が、この下で中間 CA を作る。鍵と証明書は、一緒に一度だけ作る。
# 片方だけあるときは止める（作り直すと、トラストアンカーが替わり、全部のインスタンスの agent が server を信じなくなる）
ROOT_KEY="/$PREFIX/spire/root-key"
ROOT_CERT="/$PREFIX/spire/root-cert"
if ! has_param "$ROOT_KEY" && ! has_param "$ROOT_CERT"; then
  openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt > "$SECRET_DIR/root.key"
  openssl req -x509 -new -key "$SECRET_DIR/root.key" -days 1825 -sha256 -subj "/O=$PREFIX/CN=$PREFIX SPIRE root" \
    -addext "basicConstraints=critical,CA:true" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectAltName=URI:spiffe://gekko13.internal" -out "$SECRET_DIR/root.crt"
  aws ssm put-parameter --region "$REGION" --name "$ROOT_KEY" --type SecureString --value "file://$SECRET_DIR/root.key" >/dev/null
  aws ssm put-parameter --region "$REGION" --name "$ROOT_CERT" --type SecureString --value "file://$SECRET_DIR/root.crt" >/dev/null
  rm -f "$SECRET_DIR/root.key" "$SECRET_DIR/root.crt"
  echo "SSM に SPIRE の根の CA を作った"
elif ! has_param "$ROOT_KEY" || ! has_param "$ROOT_CERT"; then
  echo "SPIRE の根の CA の鍵と証明書の片方だけが SSM にある。作り直すと信頼の根が替わるので、止める" >&2; exit 1
fi
# 固定の利用者（alice など）のパスワード（段 D の D1-a2）。ログインサーバーが、レルムの取り込みのときにハッシュにして Aurora に置く。
# CloudFront の公開の名前で誰でも試せるので、gekko_11 の「demo」は使わない。持ち主は SSM から読む（docs/runbook.md）
put_secret "/$PREFIX/login/demo-password" hex16
# SPIRE の bundle endpoint（https_web）の TLS の証明書と鍵（段 D の D1-a2。gekko_11 の D-38）。SVID とは関係のない、使い捨ての自己署名の証明書で、
# ログインサーバーが信じて、JWT-SVID を確かめる公開鍵を取る。名前は、SPIRE server のタスクの Cloud Map の名前。一緒に一度だけ作る
BUNDLE_KEY="/$PREFIX/spire/bundle-tls-key"
BUNDLE_CERT="/$PREFIX/spire/bundle-tls-cert"
if ! has_param "$BUNDLE_KEY" || ! has_param "$BUNDLE_CERT"; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$SECRET_DIR/bundle.key" -out "$SECRET_DIR/bundle.crt" -days 3650 \
    -subj "/CN=spire-server.svc.$PREFIX.internal" -addext "subjectAltName=DNS:spire-server.svc.$PREFIX.internal" >/dev/null 2>&1
  aws ssm put-parameter --region "$REGION" --name "$BUNDLE_KEY" --type SecureString --overwrite --value "file://$SECRET_DIR/bundle.key" >/dev/null
  aws ssm put-parameter --region "$REGION" --name "$BUNDLE_CERT" --type String --overwrite --value "file://$SECRET_DIR/bundle.crt" >/dev/null
  rm -f "$SECRET_DIR/bundle.key" "$SECRET_DIR/bundle.crt"
  echo "SSM に SPIRE の bundle endpoint の証明書を作った"
fi
# Aurora の証明書を確かめる CA（ap-northeast-1 の RSA2048 G1。aws/rds-ca.pem）。秘密ではないので String に置き、毎回書き直す
aws ssm put-parameter --region "$REGION" --name "/$PREFIX/db/ca" --type String --overwrite --value "file://aws/rds-ca.pem" >/dev/null

# 共有の保存先は、管理者のパスワード（上で SSM に作る）を読むので、秘密を作ったあとに作る
# 共有の保存先（Aurora Serverless v2）。初めて作るときは 10 分ほどかかる
cfn --stack-name "$PREFIX-db" --template-file aws/db.yaml --parameter-overrides \
  "SubnetIds=$(out "$PREFIX-network" SubnetIds)" \
  "VpcId=$(out "$PREFIX-network" VpcId)" \
  "HostSecurityGroupId=$(out "$PREFIX-network" HostSecurityGroupId)"
DB_HOST=$(out "$PREFIX-db" DbHost)

# パスキーの RP ID は、入口のディストリビューションのドメイン名。ディストリビューションがまだなければ空にする（ディストリビューションを作ったあとで、もう一度実行する）
rp_id() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$PREFIX-edge" \
    --query "Stacks[0].Outputs[?OutputKey=='DomainName'].OutputValue" --output text 2>/dev/null || true
}

if [ "$AZS" = 2 ]; then
  SUBNETS=$(out "$PREFIX-network" SubnetIds)
else
  SUBNETS=$(out "$PREFIX-network" SubnetId)
fi

# テンプレートは、日本語のコメントを含めると、直接送れる大きさ（51,200 バイト）を超えることがある。
# 送る前に、行頭のコメント（「# 」で始まる行）だけを除く。シバン（#!）は残す。S3 のバケットは使わない（docs/findings.md の 4-12）
TMP=$(mktemp -d)
trap 'rm -rf "$TMP" "${SECRET_DIR:?}"' EXIT
strip() { grep -v -E '^[[:space:]]*# ' "aws/$1.yaml" > "$TMP/$1.yaml"; echo "$TMP/$1.yaml"; }

cfn --stack-name "$PREFIX-ecs" --template-file "$(strip ecs)" --capabilities CAPABILITY_IAM --parameter-overrides \
  "VpcId=$(out "$PREFIX-network" VpcId)" \
  "SubnetIds=$SUBNETS" \
  "SecurityGroupId=$(out "$PREFIX-network" HostSecurityGroupId)" \
  "FileSystemId=$(out "$PREFIX-network" FileSystemId)" \
  "SpireServerAccessPointId=$(out "$PREFIX-network" SpireServerAccessPointId)" \
  "BundleAccessPointId=$(out "$PREFIX-network" BundleAccessPointId)" \
  "AssignPublicIpv4=$PUBLIC_IPV4" \
  "MaxInstances=$MAX_HOSTS" \
  "InstanceTypes=$INSTANCE_TYPES" \
  "ContainerInsights=$CONTAINER_INSIGHTS" \
  "EnableTracing=$TRACING" \
  "OtelCollectorImage=$(dualstack "$(out "$PREFIX-registry" OtelCollectorRepositoryUri)"):$OTEL" \
  "Running=$RUNNING" \
  "AppImage=$(dualstack "$APP_REPO"):$APP_TAG" \
  "SpireServerImage=$(dualstack "$(out "$PREFIX-registry" SpireServerRepositoryUri)"):$SPIRE" \
  "SpireAgentImage=$(dualstack "$(out "$PREFIX-registry" SpireAgentRepositoryUri)"):$SPIRE" \
  "SpiffeHelperImage=$(dualstack "$(out "$PREFIX-registry" SpiffeHelperRepositoryUri)"):$HELPER" \
  "DbInitImage=$(dualstack "$DB_INIT_REPO"):$DB_INIT_TAG" \
  "DbHost=$DB_HOST"

cfn --stack-name "$PREFIX-apps" --template-file "$(strip apps)" --parameter-overrides \
  "ClusterName=$(out "$PREFIX-ecs" ClusterName)" \
  "CapacityProviderName=$(out "$PREFIX-ecs" CapacityProviderName)" \
  "NamespaceArn=$(out "$PREFIX-ecs" NamespaceArn)" \
  "ExecutionRoleArn=$(out "$PREFIX-ecs" ExecutionRoleArn)" \
  "LogGroupName=$(out "$PREFIX-ecs" LogGroupName)" \
  "NamespaceId=$(out "$PREFIX-ecs" NamespaceId)" \
  "AppImage=$(dualstack "$APP_REPO"):$APP_TAG" \
  "AuthImage=$(dualstack "$AUTH_REPO"):$AUTH_TAG" \
  "KeycloakImage=$(dualstack "$KEYCLOAK_REPO"):$KEYCLOAK_TAG" \
  "SpiffeHelperImage=$(dualstack "$(out "$PREFIX-registry" SpiffeHelperRepositoryUri)"):$HELPER" \
  "SubnetIds=$(out "$PREFIX-network" SubnetIds)" \
  "HostSecurityGroupId=$(out "$PREFIX-network" HostSecurityGroupId)" \
  "DbHost=$DB_HOST" \
  "EnableAutoScaling=${GEKKO13_AUTOSCALING:-false}" \
  "EnableTracing=$TRACING" \
  "Running=$RUNNING" \
  "RpId=$(rp_id)"

# 主の流れのサービス（段 D の D1-a2）。ディストリビューションのドメイン名（RpId）から issuer と origin を作るので、
# ディストリビューションがまだなければ作らない（初めてのときは、もう一度この手順を回す）
if [ -n "$(rp_id)" ] && [ "$(rp_id)" != None ]; then
  cfn --stack-name "$PREFIX-flow" --template-file "$(strip flow)" --capabilities CAPABILITY_IAM --parameter-overrides \
    "ClusterName=$(out "$PREFIX-ecs" ClusterName)" \
    "CapacityProviderName=$(out "$PREFIX-ecs" CapacityProviderName)" \
    "NamespaceId=$(out "$PREFIX-ecs" NamespaceId)" \
    "ExecutionRoleArn=$(out "$PREFIX-ecs" ExecutionRoleArn)" \
    "LogGroupName=$(out "$PREFIX-ecs" LogGroupName)" \
    "AppImage=$(dualstack "$APP_REPO"):$APP_TAG" \
    "SpiffeHelperImage=$(dualstack "$(out "$PREFIX-registry" SpiffeHelperRepositoryUri)"):$HELPER" \
    "McpImage=$(dualstack "$MCP_REPO"):$MCP_TAG" \
    "BackendImage=$(dualstack "$BACKEND_REPO"):$BACKEND_TAG" \
    "EnableTracing=$TRACING" \
    "AuditImage=$(dualstack "$AUDIT_REPO"):$AUDIT_TAG" \
    "Running=$RUNNING" \
    "DbHost=$DB_HOST" \
    "RpId=$(rp_id)"
fi

# 入口のリバースプロキシ。ENI は 2 つの AZ のサブネットに置く。
# 振り分け（Routes）は、毎回明示して渡す。aws cloudformation deploy は、渡さないパラメーターに前の値を使い続け、テンプレートの既定値を替えても効かない（NetworkConnector は、違う AZ の 2 つのサブネットを求める）
cfn --stack-name "$PREFIX-entry" --template-file aws/entry.yaml --capabilities CAPABILITY_IAM --parameter-overrides \
  "SubnetIds=$(out "$PREFIX-network" SubnetIds)" \
  "EntrySecurityGroupId=$(out "$PREFIX-network" EntrySecurityGroupId)" \
  "CodeBucket=$ENTRY_BUCKET" \
  "CodeKey=$ENTRY_KEY" \
  "CodeVersion=$ENTRY_VERSION" \
  "NamespaceName=$(out "$PREFIX-ecs" NamespaceName)" \
  "EnableTracing=$TRACING" \
  "Routes=/login=keycloak,/audit=insurer-audit,/=customer-app" \
  "PublicOrigin=$( [ -n "$(rp_id)" ] && [ "$(rp_id)" != None ] && echo "https://$(rp_id)" )"

# 入口のディストリビューション。送り先は、入口のリバースプロキシのエンドポイント 1 つ。インスタンスが入れ替わっても、向け直しは要らない。
# ディストリビューションを初めて作ったときは、RP ID がまだ空なので、もう一度この手順を回す（keycloak のタスク数が 0 のままになる）
cfn --stack-name "$PREFIX-edge" --template-file aws/edge.yaml --parameter-overrides \
  "EntryFunctionArn=$(out "$PREFIX-entry" FunctionArn)" \
  "EntryEndpointArn=$(out "$PREFIX-entry" EndpointArn)" \
  "EntryDomainName=$(out "$PREFIX-entry" EndpointDomainName)"

# 観察のダッシュボード（段 D の D1-a3。判断 57）。無料枠（3 つまで、1 つにメトリクス 50 まで）に収める
if [ -n "$(rp_id)" ] && [ "$(rp_id)" != None ]; then
  cfn --stack-name "$PREFIX-dashboard" --template-file aws/dashboard.yaml --parameter-overrides \
    "ClusterName=$(out "$PREFIX-ecs" ClusterName)" \
    "AutoScalingGroupName=$(out "$PREFIX-ecs" AutoScalingGroupName)" \
    "CapacityProviderName=$(out "$PREFIX-ecs" CapacityProviderName)" \
    "DbClusterId=$(out "$PREFIX-db" DbClusterId)" \
    "DistributionId=$(out "$PREFIX-edge" DistributionId)" \
    "AppLogGroup=$(out "$PREFIX-ecs" LogGroupName)"
fi

echo "作った（Running=$RUNNING）。入口: https://$(rp_id)/ 。起こすのは aws/scale.sh up、使い終わったら aws/scale.sh down"
