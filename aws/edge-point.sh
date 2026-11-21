#!/usr/bin/env bash
# 入口の CloudFront のディストリビューション（スタック gekko13-edge）の VPC origin を、確認用のサービス（edge-check）が動いているインスタンスに向け、
# 効くまでの時間を測る（段 C の C-1b）。/login/* は Keycloak（段 C の C-3）。ディストリビューションがなければ作る。ディストリビューションは消さない（RP ID を保つため）。
# CloudFront は、ディストリビューションに結び付いた VPC origin を更新させない（409）。そこで、使っていない組（A か B）を新しいインスタンスに向け、
# 同じスタックの更新で、ディストリビューションをその組に切り替える。インスタンスが変わっていなければ、何も変えない。
# CloudFront が VPC に作るグループ（CloudFront-VPCOrigins-Service-SG）を、network のスタックに渡し、インスタンスがそこから受けるようにする。
# 使い方: aws/edge-point.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-ap-northeast-1}
CLUSTER=gekko13
STACK=gekko13-edge
ecs() { aws ecs --region "$REGION" "$@"; }
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

TASK=$(ecs list-tasks --cluster "$CLUSTER" --service-name edge-check --desired-status RUNNING --query 'taskArns[0]' --output text)
[ "$TASK" != None ] || { echo "edge-check のタスクが動いていない。aws/scale.sh up を先に実行する" >&2; exit 1; }
CI=$(ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containerInstanceArn' --output text)
HOST=$(ecs describe-container-instances --cluster "$CLUSTER" --container-instances "$CI" --query 'containerInstances[0].ec2InstanceId' --output text)
read -r ARN_ACCOUNT DNS < <(aws ec2 describe-instances --region "$REGION" --instance-ids "$HOST" \
  --query 'Reservations[0].[OwnerId,Instances[0].PrivateDnsName]' --output text)
ARN="arn:aws:ec2:$REGION:$ARN_ACCOUNT:instance/$HOST"
echo "送り先の台: $HOST（タスク ${TASK##*/}）"

# 今の組と、それぞれが指すインスタンス。最初の作り（組がひとつ、InstanceArn）からも引き継ぐ
param() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue|[0]" --output text 2>/dev/null || echo None; }
ACTIVE=$(param ActiveSlot) A=$(param InstanceArnA) B=$(param InstanceArnB)
if [ "$ACTIVE" = None ]; then ACTIVE=A A=$(param InstanceArn) B=None; fi
CURRENT=$([ "$ACTIVE" = A ] && echo "$A" || echo "$B")
if [ "$CURRENT" = "$ARN" ]; then
  NEXT=$ACTIVE
else
  NEXT=$([ "$ACTIVE" = A ] && echo B || echo A)
  if [ "$NEXT" = A ]; then A=$ARN; else B=$ARN; fi
fi
# まだ一度も使っていない組は、新しいインスタンスを指して作る（ディストリビューションに結び付く前なので作れる）
[ "$A" != None ] || A=$ARN
[ "$B" != None ] || B=$ARN
echo "組: $ACTIVE → $NEXT"

START=$(date +%s)
aws cloudformation deploy --region "$REGION" --stack-name "$STACK" --template-file aws/edge.yaml \
  --no-fail-on-empty-changeset --parameter-overrides "ActiveSlot=$NEXT" "InstanceArnA=$A" "InstanceArnB=$B" "OriginDomain=$DNS" >/dev/null
CFN_DONE=$(date +%s)
DOMAIN=$(out "$STACK" DomainName)
echo "配信: $DOMAIN（スタックの更新に $((CFN_DONE - START)) 秒）"

# インスタンスの受信の規則。グループは最初の VPC origin でできるので、初回だけ network のスタックが変わる
SG=$(scripts/vpc-origin-sg.sh)
[ -n "$SG" ] || { echo "CloudFront-VPCOrigins-Service-SG が VPC にない" >&2; exit 1; }
aws cloudformation deploy --region "$REGION" --stack-name gekko13-network --template-file aws/network.yaml \
  --no-fail-on-empty-changeset --parameter-overrides "CloudFrontVpcOriginSg=$SG" >/dev/null

# 2 つのエンドポイントが応えるまで待つ（上限 30 分）。app（8080）は、このインスタンスの edge-check のタスクを返すこと。
# login（8081）は Keycloak（段 C の C-3）で、レルムの discovery が、ディストリビューションのドメイン名を issuer にして返すこと
wait_for() {
  local path=$1 pattern=$2 deadline=$((START + 1800)) last=""
  until last=$(curl -s --max-time 15 "https://$DOMAIN$path") && grep -q "$pattern" <<<"$last"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then echo "30 分で届かなかった（$path）。最後の応答: ${last:0:300}" >&2; exit 1; fi
    sleep 5
  done
  echo "届いた $path: 書き換えを求めてから $(($(date +%s) - START)) 秒"
  echo "応答: ${last:0:300}"
}
wait_for /edge-point "\"task\":\"${TASK##*/}\".*\"listener\":\"app\"\|\"listener\":\"app\".*\"task\":\"${TASK##*/}\""
wait_for /login/realms/gekko13/.well-known/openid-configuration "\"issuer\":\"https://$DOMAIN/login/realms/gekko13\""
