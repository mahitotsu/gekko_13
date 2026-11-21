#!/usr/bin/env bash
# 段 D の D0 と D0-b: 台が 0 の状態から、入口（D0-b からは CloudFront → 入口の中継）を通して使えるまでの時間を測る。
# 始点: タスク数を戻した時刻。終点: 次の 3 つがそろった時刻（docs/log.md の 2026-11-21 の定義）。
#   - CloudFront を通して、Keycloak のレルムの discovery が、配信の名前を issuer にして返る
#   - auth のログに「Started AuthApplication」が出る
#   - CloudFront を通した /edge-point の応答に、2 つの違う AZ が現れる
# 内訳として、台が ASG に加わった時刻、各サービスが RUNNING になった時刻、Cloud Map のインスタンスが健康になった時刻も取る。
# 結果は local/run/d0/ に書く（local/down.sh で消えるので、残すものは先に写す）。
# 使い方: aws/d0-measure.sh
# 実行すると費用が出る。終わっても台は動いたまま。使い終わったら aws/scale.sh down で 0 にする。
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-ap-northeast-1}
LIMIT=${GEKKO13_D0_LIMIT:-300}
SERVICES="spire-server keycloak auth edge-check"
stack_out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
CLUSTER=$(stack_out gekko13-ecs ClusterName)
ASG=$(stack_out gekko13-ecs AutoScalingGroupName)
LOG_GROUP=$(stack_out gekko13-ecs LogGroupName)
DOMAIN=$(stack_out gekko13-edge DomainName)
declare -A DISCOVERY=([keycloak]=$(stack_out gekko13-apps KeycloakDiscoveryId) [edge-check]=$(stack_out gekko13-apps EdgeCheckDiscoveryId))
hosts() { aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$ASG" --query 'length(AutoScalingGroups[0].Instances)' --output text; }
now() { date +%s; }

[ "$(hosts)" = 0 ] || { echo "台が 0 ではない。aws/scale.sh down で 0 にしてから測る" >&2; exit 1; }
RUN=local/run/d0/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$RUN"

T0=$(now)
GEKKO13_NO_WAIT=1 aws/scale.sh up >/dev/null
echo "始点: タスク数を戻した（$(date -u -d "@$T0" +%H:%M:%SZ)）"

declare -A AT=()
declare -A AZ_SEEN=()
AUTH_STARTED=""
mark() { [ -n "${AT[$1]:-}" ] || { AT[$1]=$(( $(now) - T0 )); echo "  +${AT[$1]} 秒: $1"; }; }
# ログの時刻（ミリ秒）から、始点からの秒を出す。CLI はページごとに --query を当てるので、数字だけを取る
log_time() {
  local ms
  ms=$(aws logs filter-log-events --region "$REGION" --log-group-name "$LOG_GROUP" --log-stream-name-prefix "$1" \
    --filter-pattern "\"$2\"" --start-time "$((T0 * 1000))" --query 'events[].timestamp' --output text 2>/dev/null |
    tr -s '\t ' '\n' | grep -E '^[0-9]+$' | sort -n | head -1 || true)
  [ -z "$ms" ] || echo $(( ms / 1000 - T0 ))
}

DEADLINE=$((T0 + 1800))
while :; do
  [ "$(now)" -lt "$DEADLINE" ] || { echo "30 分で終わらなかった" >&2; exit 1; }
  n=$(hosts)
  [ "$n" -ge 1 ] && mark "1 台目が ASG に加わった"
  [ "$n" -ge 2 ] && mark "2 台目が ASG に加わった"
  while read -r name running; do
    [ "$running" -ge 1 ] && mark "$name が RUNNING"
  done < <(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services $SERVICES \
    --query 'services[].[serviceName,runningCount]' --output text)
  for k in keycloak edge-check; do
    h=$(aws servicediscovery get-instances-health-status --region "$REGION" --service-id "${DISCOVERY[$k]}" \
      --query 'length(Status.* | [?@==`HEALTHY`])' --output text 2>/dev/null || echo 0)
    [ "$h" -ge 1 ] && mark "$k が Cloud Map で健康になった"
  done
  # 入口を通した応答。edge-check は呼ぶたびに中継が送り先を選ぶので、何度か呼んで AZ を集める
  if [ -z "${AT[CloudFront を通して Keycloak が応えた]:-}" ] &&
    curl -s --max-time 10 "https://$DOMAIN/login/realms/gekko13/.well-known/openid-configuration" |
    grep -q "\"issuer\":\"https://$DOMAIN/login/realms/gekko13\""; then
    mark "CloudFront を通して Keycloak が応えた"
  fi
  for _ in 1 2 3 4; do
    az=$(curl -s --max-time 10 "https://$DOMAIN/edge-point" | grep -o '"az":"[a-z0-9-]*"' | cut -d'"' -f4 || true)
    [ -z "$az" ] || AZ_SEEN[$az]=1
  done
  [ "${#AZ_SEEN[@]}" -ge 1 ] && mark "CloudFront を通して edge-check が応えた（1 つめの AZ）"
  [ "${#AZ_SEEN[@]}" -ge 2 ] && mark "CloudFront を通して 2 つめの AZ の edge-check が応えた"
  [ -n "$AUTH_STARTED" ] || { AUTH_STARTED=$(log_time auth/app "Started AuthApplication"); [ -z "$AUTH_STARTED" ] || echo "  +$AUTH_STARTED 秒: auth が起動した（ログの時刻）"; }
  [ -n "${AT[CloudFront を通して Keycloak が応えた]:-}" ] && [ -n "${AT[CloudFront を通して 2 つめの AZ の edge-check が応えた]:-}" ] &&
    [ -n "$AUTH_STARTED" ] && break
  sleep 5
done

KC=${AT["CloudFront を通して Keycloak が応えた"]}
AZ2=${AT["CloudFront を通して 2 つめの AZ の edge-check が応えた"]}
END=$KC
[ "$AZ2" -gt "$END" ] && END=$AZ2
[ "$AUTH_STARTED" -gt "$END" ] && END=$AUTH_STARTED
KC_STARTED=$(log_time keycloak/app "started in")
{
  echo "# D0-b の測定 $(basename "$RUN")"
  echo
  echo "| 出来事 | 始点からの秒 |"
  echo "|---|---|"
  for k in "${!AT[@]}"; do echo "| $k | ${AT[$k]} |"; done | sort -t'|' -k3 -n
  echo "| Keycloak の起動（ログの時刻） | ${KC_STARTED:-不明} |"
  echo "| auth の起動（ログの時刻） | $AUTH_STARTED |"
  echo "| **終点（使えるまで）** | **$END** |"
  echo
  echo "現れた AZ: ${!AZ_SEEN[*]}"
  echo "判定（${LIMIT} 秒以内か）: $([ "$END" -le "$LIMIT" ] && echo 以内 || echo 超えた)"
} | tee "$RUN/result.md"
echo "結果: $RUN/result.md（local/down.sh で消えるので、残すものは先に写す）"
