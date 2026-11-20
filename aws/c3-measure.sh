#!/usr/bin/env bash
# 段 C の C-3: 台が 0 の状態から、ログインサーバー（Keycloak）と認可サーバー（auth）が使えるまでの時間を測る。
# 始点: タスク数を戻した時刻。終点: 次の 2 つがそろった時刻（docs/log.md の 2026-11-20 の定義）。
#   - CloudFront を通して、Keycloak のレルムの discovery が、配信の名前を issuer にして返る（aws/edge-point.sh が待つ）
#   - auth のログに「Started AuthApplication」が出る
# VPC origin の向け直し（aws/edge-point.sh）も含める。edge-check のタスクが動き出したら、すぐに向け直しを始める。
# そのあと HOLD 分（既定 10）置いて、メモリの不足で止まったタスクがないかと、Container Insights のメモリの最大を見る。
# 結果は local/run/c3/ に書く（local/down.sh で消えるので、残すものは先に写す）。
# 使い方: aws/c3-measure.sh [HOLD の分。0 で省く]
# 実行すると費用が出る。終わっても台は動いたまま。使い終わったら aws/scale.sh down で 0 にする。
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-ap-northeast-1}
HOLD=${1:-10}
CLUSTER=gekko13
LOG_GROUP=/gekko13/ecs
SERVICES="spire-server edge-check keycloak auth bff transfer ledger"
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name gekko13-ecs --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
ASG=$(out AutoScalingGroupName)
hosts() { aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$ASG" --query 'length(AutoScalingGroups[0].Instances)' --output text; }
now() { date +%s; }

[ "$(hosts)" = 0 ] || { echo "台が 0 ではない。aws/scale.sh down で 0 にしてから測る" >&2; exit 1; }
RUN=local/run/c3/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$RUN"
TYPE=$(aws ec2 describe-launch-template-versions --region "$REGION" \
  --launch-template-id "$(aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$ASG" --query 'AutoScalingGroups[0].LaunchTemplate.LaunchTemplateId' --output text)" \
  --versions '$Latest' --query 'LaunchTemplateVersions[0].LaunchTemplateData.InstanceType' --output text)
echo "台の大きさ: $TYPE"

T0=$(now)
GEKKO13_NO_WAIT=1 aws/scale.sh up >/dev/null
echo "始点: タスク数を戻した（$(date -u -d "@$T0" +%H:%M:%SZ)）"

declare -A AT=()
EDGE_PID=""
EDGE_DONE=""
AUTH_STARTED=""
mark() { [ -n "${AT[$1]:-}" ] || { AT[$1]=$(( $(now) - T0 )); echo "  +${AT[$1]} 秒: $1"; }; }
# ログの時刻（ミリ秒）から、始点からの秒を出す
log_time() {
  local ms
  # CLI はページごとに --query を当てるので、空のページの「None」と時刻が混ざって出る。数字だけを取り、最も早いものを使う
  ms=$(aws logs filter-log-events --region "$REGION" --log-group-name "$LOG_GROUP" --log-stream-name-prefix "$1" \
    --filter-pattern "\"$2\"" --start-time "$((T0 * 1000))" --query 'events[].timestamp' --output text 2>/dev/null |
    tr -s '\t ' '\n' | grep -E '^[0-9]+$' | sort -n | head -1 || true)
  [ -z "$ms" ] || echo $(( ms / 1000 - T0 ))
}

DEADLINE=$((T0 + 2400))
while :; do
  [ "$(now)" -lt "$DEADLINE" ] || { echo "40 分で終わらなかった" >&2; exit 1; }
  [ "$(hosts)" = 0 ] || mark "台が ASG に加わった"
  while read -r name running; do
    [ "$running" -ge 1 ] && mark "$name が RUNNING"
  done < <(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services $SERVICES \
    --query 'services[].[serviceName,runningCount]' --output text)
  # 向け直しは、edge-check のタスクがいる台に向ける。動き出したらすぐに始める
  if [ -z "$EDGE_PID" ] && [ -n "${AT[edge-check が RUNNING]:-}" ]; then
    mark "向け直しを始めた"
    aws/edge-point.sh > "$RUN/edge-point.txt" 2>&1 &
    EDGE_PID=$!
  fi
  if [ -n "$EDGE_PID" ] && [ -z "$EDGE_DONE" ] && ! kill -0 "$EDGE_PID" 2>/dev/null; then
    wait "$EDGE_PID" || { echo "aws/edge-point.sh が失敗した（$RUN/edge-point.txt）" >&2; cat "$RUN/edge-point.txt" >&2; exit 1; }
    mark "CloudFront を通して Keycloak が応えた"
    EDGE_DONE=1
  fi
  [ -n "$AUTH_STARTED" ] || { AUTH_STARTED=$(log_time auth/app "Started AuthApplication"); [ -z "$AUTH_STARTED" ] || echo "  +$AUTH_STARTED 秒: auth が起動した（ログの時刻）"; }
  [ -n "$EDGE_DONE" ] && [ -n "$AUTH_STARTED" ] && break
  sleep 5
done

KC_STARTED=$(log_time keycloak/app "started in")
KC_EDGE=${AT["CloudFront を通して Keycloak が応えた"]}
END=$(( KC_EDGE > AUTH_STARTED ? KC_EDGE : AUTH_STARTED ))
{
  echo "# C-3 の測定 $(basename "$RUN")（台 $TYPE）"
  echo
  echo "| 出来事 | 始点からの秒 |"
  echo "|---|---|"
  for k in "${!AT[@]}"; do echo "| $k | ${AT[$k]} |"; done | sort -t'|' -k3 -n
  echo "| Keycloak の起動（ログの時刻） | ${KC_STARTED:-不明} |"
  echo "| auth の起動（ログの時刻） | $AUTH_STARTED |"
  echo "| **終点（使えるまで）** | **$END** |"
  echo
  echo "判定（600 秒以内か）: $([ "$END" -le 600 ] && echo 以内 || echo 超えた)"
  echo
  echo '```'
  cat "$RUN/edge-point.txt"
  echo '```'
} | tee "$RUN/result.md"

[ "$HOLD" -gt 0 ] || exit 0
echo "$HOLD 分置いて、メモリの不足で止まったタスクがないかを見る"
sleep $((HOLD * 60))
{
  echo
  echo "## $HOLD 分置いたあと"
  # 始点よりあとに起きて止まったタスクを見る（ECS は止まったタスクを 1 時間ほど返す。前の回のものは除く）
  STOPPED=$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" --desired-status STOPPED --query 'taskArns[:100]' --output text)
  OOM=0
  if [ -n "$STOPPED" ] && [ "$STOPPED" != None ]; then
    # shellcheck disable=SC2086
    aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks $STOPPED --output json > "$RUN/stopped.json"
    while IFS=$'\t' read -r group reason; do
      echo "- 止まったタスク: $group: $reason"
      grep -qi 'memory' <<<"$reason" && OOM=$((OOM + 1))
    done < <(python3 -I - "$RUN/stopped.json" "$T0" <<'PY'
import json, sys
from datetime import datetime
tasks = json.load(open(sys.argv[1]))["tasks"]
t0 = int(sys.argv[2])
for t in tasks:
    created = t.get("createdAt")
    ts = datetime.fromisoformat(created).timestamp() if isinstance(created, str) else float(created or 0)
    if ts < t0:
        continue
    reasons = [t.get("stoppedReason") or ""] + [c.get("reason") or "" for c in t.get("containers", [])]
    print(f'{t.get("group")}\t{" / ".join(r for r in reasons if r)}')
PY
)
  fi
  echo "- メモリの不足で止まったタスク: $OOM 件"
  echo
  echo "| サービス | メモリの最大（MiB、Container Insights） |"
  echo "|---|---|"
  for s in $SERVICES; do
    m=$(aws cloudwatch get-metric-statistics --region "$REGION" --namespace ECS/ContainerInsights --metric-name MemoryUtilized \
      --dimensions "Name=ClusterName,Value=$CLUSTER" "Name=ServiceName,Value=$s" \
      --start-time "$(date -u -d "@$T0" +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" --period 60 --statistics Maximum \
      --query 'max(Datapoints[].Maximum)' --output text 2>/dev/null || echo None)
    echo "| $s | $m |"
  done
} | tee -a "$RUN/result.md"
echo "結果: $RUN/result.md（local/down.sh で消えるので、残すものは先に写す）"
