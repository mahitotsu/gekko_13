#!/usr/bin/env bash
# 段 D の D1-a3: インスタンスが 0 の状態から、CloudFront を通して主の流れが使えるまでの時間を測る。定義は docs/log.md の 2026-11-23 の決定。
#   始点: aws/scale.sh up を呼ぶ直前（Running を true にする。スタックの更新が始まるまでの数秒も含む）。
#   終点: 次の 3 つがそろった時刻。CloudFront を通して Keycloak の discovery が、ディストリビューションのドメイン名を issuer にして返る。
#         auth のログに「Started InsurerAuthApplication」が出る。CloudFront を通して、主の流れ（scripts/ui-flow.ts）が最後まで通る（通った回が終わった時刻）。
#   内訳: インスタンスが ASG に加わった時刻。全部のサービスで 2 タスクが動き、2 つの AZ に分かれた時刻（終点には入れない）。
# 主の流れは、手元の Docker の Playwright（BROWSER_WS、既定 ws://127.0.0.1:3334/）で回す。固定の利用者のパスワードは SSM から読み、表示しない。
# 結果は local/run/d1a3/ に書く（local/down.sh で消えるので、残すものは先に写す）。
# 使い方: aws/d1a3-measure.sh。前提: インスタンスが 0（aws/scale.sh down のあと）。終わってもインスタンスは動いたまま。
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-ap-northeast-1}
LIMIT=${GEKKO13_D1A3_LIMIT:-300}
SERVICES="spire-server keycloak auth customer-app sales-agent insurer-mcp insurer-backend insurer-audit"
stack_out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
CLUSTER=$(stack_out gekko13-ecs ClusterName)
ASG=$(stack_out gekko13-ecs AutoScalingGroupName)
LOG_GROUP=$(stack_out gekko13-ecs LogGroupName)
DOMAIN=$(stack_out gekko13-edge DomainName)
DEMO_PASSWORD=$(aws ssm get-parameter --region "$REGION" --name /gekko13/login/demo-password --with-decryption --query Parameter.Value --output text)
export DEMO_PASSWORD
hosts() { aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$ASG" --query 'length(AutoScalingGroups[0].Instances)' --output text; }
now() { date +%s; }

# 前提。1 つでも崩れていたら測らない
# shellcheck source=aws/lib.sh
. aws/lib.sh
[ "$(hosts)" = 0 ] || { echo "台が 0 ではない。aws/scale.sh down で 0 にしてから測る" >&2; exit 1; }
for s in $RUN_STACKS; do
  [ "$(running_of "$s")" = false ] || { echo "$s の Running が false でない。aws/scale.sh down で 0 にしてから測る" >&2; exit 1; }
done
# shellcheck disable=SC2086
check_ready $RUN_STACKS
verify_counts false "$CLUSTER"
DB_CLUSTER=$(out gekko13-db DbClusterId)
ACU=$(aws cloudwatch get-metric-statistics --region "$REGION" --namespace AWS/RDS --metric-name ServerlessDatabaseCapacity \
  --dimensions "Name=DBClusterIdentifier,Value=$DB_CLUSTER" --start-time "$(date -u -d '-5 min' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 60 --statistics Maximum --query 'sort_by(Datapoints,&Timestamp)[-1].Maximum' --output text)
[ "$ACU" = 0.0 ] || { echo "Aurora が 0 ACU ではない（$ACU）。一時停止するまで待ってから測る" >&2; exit 1; }
RUN=local/run/d1a3/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$RUN"

T0=$(now)
GEKKO13_NO_WAIT=1 aws/scale.sh up >/dev/null
echo "始点: タスク数を戻した（$(date -u -d "@$T0" +%H:%M:%SZ)）"

declare -A AT=()
mark() { [ -n "${AT[$1]:-}" ] || { AT[$1]=$(( $(now) - T0 )); echo "  +${AT[$1]} 秒: $1"; }; }
log_time() {
  local ms
  ms=$(aws logs filter-log-events --region "$REGION" --log-group-name "$LOG_GROUP" --log-stream-name-prefix "$1" \
    --filter-pattern "\"$2\"" --start-time "$((T0 * 1000))" --query 'events[].timestamp' --output text 2>/dev/null |
    tr -s '\t ' '\n' | grep -E '^[0-9]+$' | sort -n | head -1 || true)
  [ -z "$ms" ] || echo $(( ms / 1000 - T0 ))
}
# 全部のサービスで、動いているタスクが 2 つ以上あり、2 つの AZ に分かれているか
all_spread() {
  local s azs
  for s in $SERVICES; do
    azs=$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" --service-name "$s" --desired-status RUNNING --query 'taskArns' --output text |
      xargs -r -n 100 aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --query 'tasks[?lastStatus==`RUNNING`].availabilityZone' --output text --tasks |
      tr -s '\t ' '\n' | grep . || true)
    [ "$(grep -c . <<<"$azs")" -ge 2 ] && [ "$(sort -u <<<"$azs" | grep -c .)" -ge 2 ] || return 1
  done
}

AUTH_STARTED=""
FLOWS=0
DEADLINE=$((T0 + 1800))
while :; do
  [ "$(now)" -lt "$DEADLINE" ] || { echo "30 分で終わらなかった" >&2; exit 1; }
  n=$(hosts)
  for i in 1 2 3 4; do [ "$n" -ge "$i" ] && mark "$i 台目が ASG に加わった"; done
  if [ -z "${AT[CloudFront を通して Keycloak が応えた]:-}" ] &&
    curl -s --max-time 10 "https://$DOMAIN/login/realms/insurer/.well-known/openid-configuration" |
    grep -q "\"issuer\":\"https://$DOMAIN/login/realms/insurer\""; then
    mark "CloudFront を通して Keycloak が応えた"
  fi
  [ -n "$AUTH_STARTED" ] || { AUTH_STARTED=$(log_time auth/app "Started InsurerAuthApplication"); [ -z "$AUTH_STARTED" ] || echo "  +$AUTH_STARTED 秒: auth が起動した（ログの時刻）"; }
  # 主の流れは、Keycloak と auth が応えてから回す。通らなければ、次の周でもう一度回す
  if [ -n "${AT[CloudFront を通して Keycloak が応えた]:-}" ] && [ -n "$AUTH_STARTED" ] && [ -z "${AT[主の流れが通った]:-}" ]; then
    FLOWS=$((FLOWS + 1))
    FLOW_START=$(( $(now) - T0 ))
    if timeout 240 node scripts/ui-flow.ts "https://$DOMAIN" > "$RUN/flow-$FLOWS.log" 2>&1; then
      mark "主の流れが通った"
    else
      echo "  +$(( $(now) - T0 )) 秒: 主の流れの $FLOWS 回目は通らなかった（$(grep -o '"step":"[^"]*","ok":false' "$RUN/flow-$FLOWS.log" | head -1)）"
    fi
  fi
  [ -n "${AT[全部のサービスが 2 タスクで 2 つの AZ に分かれた]:-}" ] || { all_spread && mark "全部のサービスが 2 タスクで 2 つの AZ に分かれた"; }
  [ -n "${AT[主の流れが通った]:-}" ] && [ -n "${AT[全部のサービスが 2 タスクで 2 つの AZ に分かれた]:-}" ] && break
  # 主の流れが通ってから 10 分たっても分かれなければ、内訳は「なし」で終える
  FLOW_AT=${AT["主の流れが通った"]:-}
  [ -n "$FLOW_AT" ] && [ "$(( $(now) - T0 - FLOW_AT ))" -gt 600 ] && break
  sleep 5
done

KC=${AT["CloudFront を通して Keycloak が応えた"]}
FLOW=${AT["主の流れが通った"]}
END=$KC
[ "$AUTH_STARTED" -gt "$END" ] && END=$AUTH_STARTED
[ "$FLOW" -gt "$END" ] && END=$FLOW
# 内訳（ログの時刻）。終点には入れない
SERVER_AT=$(log_time spire-server/spire-server "Starting Server APIs")
AGENT_AT=$(log_time spire-agent/spire-agent "Node attestation was successful")
{
  echo "# D1-a3 の測定 $(basename "$RUN")"
  echo
  echo "| 出来事 | 始点からの秒 |"
  echo "|---|---|"
  for k in "${!AT[@]}"; do echo "| $k | ${AT[$k]} |"; done | sort -t'|' -k3 -n
  echo "| auth の起動（ログの時刻） | $AUTH_STARTED |"
  echo "| server が受け始めた（内訳、ログの時刻） | ${SERVER_AT:-なし} |"
  echo "| 最初の agent の attestation（内訳、ログの時刻） | ${AGENT_AT:-なし} |"
  echo "| 通った流れの始まり（内訳） | $FLOW_START |"
  echo "| **終点（使えるまで）** | **$END** |"
  echo
  echo "主の流れを回した回数: $FLOWS（1 回目で通ったか: $([ "$FLOWS" = 1 ] && echo はい || echo いいえ)）。台の数: $(hosts)"
  echo "判定（${LIMIT} 秒以内か）: $([ "$END" -le "$LIMIT" ] && echo 以内 || echo 超えた)"
} | tee "$RUN/result.md"
echo "結果: $RUN/result.md（local/down.sh で消えるので、残すものは先に写す）"
