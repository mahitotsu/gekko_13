#!/usr/bin/env bash
# 段 D の D1-a1: 台を 1 台、予告なしに止めて（スポットの中断より厳しい条件）、入口からの要求がどれだけ失敗するかを測る。
# 止める前から 2 秒ごとに、CloudFront を通して /edge-point と Keycloak の discovery を呼び、時刻と状態を記録する。
# 止めたあと、代わりの auth のタスクが起動するまで（SVID がないと起動しないので、新しいタスクに SVID が出たことも分かる）を待つ。
# 結果は local/run/failover/<時刻>/ に書く（local/down.sh で消えるので、残すものは先に写す）。
# 使い方: aws/failover-check.sh [止めたあとに見る秒（既定 480）]
# 実行すると費用が出る。台を 1 台止めるので、ASG が代わりの台を起こす。前提: 台が 2 台で、全部のサービスが安定している。
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-ap-northeast-1}
WATCH=${1:-480}
stack_out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
CLUSTER=$(stack_out gekko13-ecs ClusterName)
ASG=$(stack_out gekko13-ecs AutoScalingGroupName)
LOG_GROUP=$(stack_out gekko13-ecs LogGroupName)
DOMAIN=$(stack_out gekko13-edge DomainName)
RUN=local/run/failover/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$RUN"

hosts=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$ASG" \
  --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`].InstanceId' --output text)
[ "$(wc -w <<<"$hosts")" -ge 2 ] || { echo "台が 2 台ない（$hosts）。aws/scale.sh up のあとで回す" >&2; exit 1; }
VICTIM=$(awk '{print $1}' <<<"$hosts")
AZ=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$VICTIM" --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)
# 止める台に載っているタスク（サービスごと）
container_instance=$(aws ecs list-container-instances --region "$REGION" --cluster "$CLUSTER" --filter "ec2InstanceId == $VICTIM" --query 'containerInstanceArns[0]' --output text)
aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" --container-instance "$container_instance" --query 'taskArns' --output text |
  xargs -r -n 100 aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --query 'tasks[].group' --output text --tasks |
  tr '\t' '\n' | sort | uniq -c > "$RUN/victim-tasks.txt"
echo "止める台: $AZ の 1 台。載っているタスク:"; sed 's/^/  /' "$RUN/victim-tasks.txt"

# 2 秒ごとに入口を呼ぶ。行は「始点からの秒 種類 状態」
probe() {
  local t0=$1
  while :; do
    now=$(date +%s)
    e=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/edge-point" || echo 000)
    k=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/login/realms/gekko13/.well-known/openid-configuration" || echo 000)
    echo "$((now - t0)) edge $e"
    echo "$((now - t0)) login $k"
    sleep 2
  done
}
T0=$(( $(date +%s) + 20 ))
probe "$T0" > "$RUN/probe.txt" &
PROBE=$!
trap 'kill $PROBE 2>/dev/null || true' EXIT
sleep 20
aws ec2 terminate-instances --region "$REGION" --instance-ids "$VICTIM" >/dev/null
echo "始点: 台を止めた（$(date -u -d "@$T0" +%H:%M:%SZ)）。$WATCH 秒見る"

# 代わりの auth が起動したか（ログの時刻）。止めたあとに出た「Started AuthApplication」
AUTH_BACK=""
END=$((T0 + WATCH))
while [ "$(date +%s)" -lt "$END" ]; do
  if [ -z "$AUTH_BACK" ]; then
    ms=$(aws logs filter-log-events --region "$REGION" --log-group-name "$LOG_GROUP" --log-stream-name-prefix auth/app \
      --filter-pattern '"Started AuthApplication"' --start-time "$((T0 * 1000))" --query 'events[].timestamp' --output text 2>/dev/null |
      tr -s '\t ' '\n' | grep -E '^[0-9]+$' | sort -n | head -1 || true)
    [ -z "$ms" ] || { AUTH_BACK=$((ms / 1000 - T0)); echo "  +$AUTH_BACK 秒: 代わりの auth が起動した（SVID が出た）"; }
  fi
  sleep 15
done
kill $PROBE 2>/dev/null || true

# 止めたあとの失敗（200 でない応答）の数と、最初と最後の秒
summary() {
  awk -v kind="$1" '$2 == kind && $1 >= 0 { n++; if ($3 != "200") { f++; if (first == "") first = $1; last = $1 } }
    END { printf "| %s | %d | %d | %s | %s |\n", kind, n, f, (first == "" ? "-" : first), (last == "" ? "-" : last) }' "$RUN/probe.txt"
}
{
  echo "# 台を 1 台止めたときの失敗 $(basename "$RUN")"
  echo
  echo "止めた台の AZ: $AZ。載っていたタスク: $(awk '{printf "%s×%s ", $2, $1}' "$RUN/victim-tasks.txt")"
  echo
  echo "| 呼んだもの | 呼んだ数 | 失敗の数 | 最初の失敗（秒） | 最後の失敗（秒） |"
  echo "|---|---|---|---|---|"
  summary edge
  summary login
  echo
  echo "代わりの auth の起動（秒）: ${AUTH_BACK:-${WATCH} 秒の間に出なかった}"
  echo "失敗の状態の内訳: $(awk '$1 >= 0 && $3 != "200" {print $2"="$3}' "$RUN/probe.txt" | sort | uniq -c | tr -s ' ' | paste -sd, -)"
} | tee "$RUN/result.md"
echo "結果: $RUN/result.md（local/down.sh で消えるので、残すものは先に写す）"
