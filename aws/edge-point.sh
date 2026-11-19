#!/usr/bin/env bash
# 入口の CloudFront の配信（スタック gekko13-edge）の VPC origin を、確認用のサービス（edge-check）が動いている台に向け、
# 効くまでの時間を測る（段 C の C-1b）。配信がなければ作り、あれば InstanceArn と OriginDomain を書き換える。配信は消さない（RP ID を保つため）。
# CloudFront が VPC に作るグループ（CloudFront-VPCOrigins-Service-SG）を、network のスタックに渡し、台がそこから受けるようにする。
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

START=$(date +%s)
aws cloudformation deploy --region "$REGION" --stack-name "$STACK" --template-file aws/edge.yaml \
  --no-fail-on-empty-changeset --parameter-overrides "InstanceArn=$ARN" "OriginDomain=$DNS" >/dev/null
CFN_DONE=$(date +%s)
DOMAIN=$(out "$STACK" DomainName)
echo "配信: $DOMAIN（スタックの更新に $((CFN_DONE - START)) 秒）"

# 台の受信の規則。グループは最初の VPC origin でできるので、初回だけ network のスタックが変わる
SG=$(scripts/vpc-origin-sg.sh)
[ -n "$SG" ] || { echo "CloudFront-VPCOrigins-Service-SG が VPC にない" >&2; exit 1; }
aws cloudformation deploy --region "$REGION" --stack-name gekko13-network --template-file aws/network.yaml \
  --no-fail-on-empty-changeset --parameter-overrides "CloudFrontVpcOriginSg=$SG" >/dev/null

# 2 つの受け口が、それぞれこの台のタスクを返すまで待つ（上限 30 分）
wait_for() {
  local path=$1 listener=$2 deadline=$((START + 1800)) last=""
  until last=$(curl -s --max-time 15 "https://$DOMAIN$path") && grep -q "\"task\":\"${TASK##*/}\"" <<<"$last" &&
    grep -q "\"listener\":\"$listener\"" <<<"$last"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then echo "30 分で届かなかった（$path）。最後の応答: ${last:0:300}" >&2; exit 1; fi
    sleep 10
  done
  echo "届いた $path: 書き換えを求めてから $(($(date +%s) - START)) 秒"
  echo "応答: $last"
}
wait_for /edge-point app
wait_for /login/edge-point login
