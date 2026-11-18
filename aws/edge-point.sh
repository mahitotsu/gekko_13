#!/usr/bin/env bash
# 段 C の C-1: CloudFront の送り先を、確認用のサービス（edge-check）が動いている台に向け、効くまでの時間を測る。
# 送り先の名前は、台の公開 IPv6 のアドレスを埋め込んだ sslip.io の名前（AAAA だけを返す）。試しの間だけ使う（docs/plan.md の C-1a）。
# 配信のスタック gekko13-edge がなければ作り、あれば OriginDomain を書き換える。配信は消さない（RP ID を保つため）。
# 使い方: aws/edge-point.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-ap-northeast-1}
CLUSTER=gekko13
STACK=gekko13-edge
ecs() { aws ecs --region "$REGION" "$@"; }

TASK=$(ecs list-tasks --cluster "$CLUSTER" --service-name edge-check --desired-status RUNNING --query 'taskArns[0]' --output text)
[ "$TASK" != None ] || { echo "edge-check のタスクが動いていない。aws/scale.sh up を先に実行する" >&2; exit 1; }
CI=$(ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containerInstanceArn' --output text)
HOST=$(ecs describe-container-instances --cluster "$CLUSTER" --container-instances "$CI" --query 'containerInstances[0].ec2InstanceId' --output text)
IP6=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$HOST" \
  --query 'Reservations[0].Instances[0].NetworkInterfaces[0].Ipv6Addresses[0].Ipv6Address' --output text)
NAME=$(python3 -I -c 'import ipaddress, sys; print(ipaddress.ip_address(sys.argv[1]).exploded.replace(":", "-") + ".sslip.io")' "$IP6")
echo "送り先の台: $HOST（タスク ${TASK##*/}）"

# 名前が、台の IPv6 のアドレスを返すかを先に確かめる
RESOLVED=$(getent ahostsv6 "$NAME" | awk 'NR==1 {print $1}')
[ "$(python3 -I -c 'import ipaddress, sys; print(ipaddress.ip_address(sys.argv[1]) == ipaddress.ip_address(sys.argv[2]))' "$RESOLVED" "$IP6")" = True ] ||
  { echo "送り先の名前が、台の IPv6 のアドレスを返さない" >&2; exit 1; }

START=$(date +%s)
aws cloudformation deploy --region "$REGION" --stack-name "$STACK" --template-file aws/edge.yaml \
  --no-fail-on-empty-changeset --parameter-overrides "OriginDomain=$NAME" >/dev/null
CFN_DONE=$(date +%s)
DOMAIN=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='DomainName'].OutputValue" --output text)
echo "配信: $DOMAIN（スタックの更新に $((CFN_DONE - START)) 秒）"

# CloudFront の応答が、この台のタスクを返すまで待つ（上限 30 分）
DEADLINE=$((START + 1800))
LAST=""
until LAST=$(curl -s --max-time 15 "https://$DOMAIN/edge-point") && grep -q "\"task\":\"${TASK##*/}\"" <<<"$LAST"; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then echo "30 分で届かなかった。最後の応答: ${LAST:0:300}" >&2; exit 1; fi
  sleep 10
done
END=$(date +%s)
echo "届いた: 書き換えを求めてから $((END - START)) 秒（スタックの更新のあと $((END - CFN_DONE)) 秒）"
echo "応答: $LAST"
