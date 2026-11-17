#!/usr/bin/env bash
# AWS の段: シナリオを、プローブの 3 つの役（probe-bff、probe-transfer、probe-ledger。普段はタスク数 0）として回す。
# 各役は、本物のファミリーのタスクとして自分の SVID を得て、Service Connect の中から攻撃する（「乗っ取られたタスク」）。
# 試験の間だけタスク数を 1 にし、終わったら必ず 0 に戻す。結果は scripts/aws-collect.ts がまとめ、local/run/ に置く。
# どの台にプローブが置かれてもよい（台の数と配置に依らない）。
# 前提: aws/deploy.sh で作り、aws/scale.sh up で動かし、aws/create-user.sh と node scripts/aws-login.ts を済ませた
#       （リフレッシュトークンは 60 分で切れる）。
# 使い方:
#   aws/run-scenarios.sh                シナリオ（1-a、1-b、3-a〜3-g）。タスクの置き場所も記録する（段 B の B-1）
#   aws/run-scenarios.sh soak 30        入れ替えの試験を 30 分（probe-bff だけが連鎖を呼び続ける）
#   aws/run-scenarios.sh failover 30    soak と同じ試験の途中で、SPIRE server を別の AZ（なければ別の台）に移す（段 B の B-4）。
#                                       移す時刻は、始めてから FAILOVER_AFTER 分（既定 10）
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-ap-northeast-1}
MODE=${1:-scenarios}
MINUTES=${2:-30}
FAILOVER_AFTER=${FAILOVER_AFTER:-10}
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name gekko13-ecs --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
ecs() { aws ecs --region "$REGION" "$@"; }
CLUSTER=$(out ClusterName)
LOGS=$(out LogGroupName)
CP=$(out CapacityProviderName)
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
mkdir -p local/run
DIR=local/run/aws-$MODE-$STAMP
mkdir -p "$DIR"

case "$MODE" in
  scenarios) PROBE_MODE=scenarios; ROLES="bff transfer ledger"; WAIT_S=900 ;;
  soak|failover) PROBE_MODE="soak $MINUTES"; ROLES="bff"; WAIT_S=$((MINUTES * 60 + 900)) ;;
  *) echo "scenarios、soak、failover のどれかを渡す: $MODE" >&2; exit 2 ;;
esac
if [ "$MODE" = failover ] && [ "$FAILOVER_AFTER" -ge "$MINUTES" ]; then
  echo "FAILOVER_AFTER（$FAILOVER_AFTER 分）は、試験の長さ（$MINUTES 分）より短くする" >&2; exit 2
fi
# プローブは、起動のときにこの値を環境変数 PROBE_MODE として受け取る
aws ssm put-parameter --region "$REGION" --name /gekko13/probe/mode --type String --overwrite --value "$PROBE_MODE" >/dev/null

ROGUE=""
FO_PID=""
cleanup() {
  if [ -n "$FO_PID" ]; then kill "$FO_PID" 2>/dev/null || true; fi
  for r in bff transfer ledger; do ecs update-service --cluster "$CLUSTER" --service "probe-$r" --desired-count 0 >/dev/null || true; done
  if [ -n "$ROGUE" ]; then ecs stop-task --cluster "$CLUSTER" --task "$ROGUE" >/dev/null 2>&1 || true; fi
  echo "プローブのタスク数を 0 に戻した"
}
trap cleanup EXIT

logs_of() {
  aws logs get-log-events --region "$REGION" --log-group-name "$LOGS" --log-stream-name "$1" \
    --start-from-head --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n'
}
# 時刻つき（1 行に「ミリ秒<TAB>メッセージ」）。server の入れ替えの時間を測るのに使う
logs_with_time() {
  aws logs get-log-events --region "$REGION" --log-group-name "$LOGS" --log-stream-name "$1" \
    --start-from-head --query 'events[].[timestamp,message]' --output text 2>/dev/null
}
host_of() { ecs describe-container-instances --cluster "$CLUSTER" --container-instances "$1" --query 'containerInstances[0].ec2InstanceId' --output text; }

# B-1: bff、transfer、ledger のタスクの置き場所。1 行に「サービス タスク AZ 台」
placement() {
  for s in bff transfer ledger; do
    local tasks
    tasks=$(ecs list-tasks --cluster "$CLUSTER" --service-name "$s" --desired-status RUNNING --query 'taskArns' --output text)
    [ -n "$tasks" ] || continue
    # shellcheck disable=SC2086
    ecs describe-tasks --cluster "$CLUSTER" --tasks $tasks --query 'tasks[].[taskArn,availabilityZone,containerInstanceArn]' --output text |
      while read -r arn az ci; do echo "$s ${arn##*/} $az $(host_of "$ci")"; done
  done
}

# B-4: SPIRE server を、今の AZ 以外（別の AZ に台がなければ、今の台以外）に移す。サービスに制約を付けて、新しいデプロイを強制する。
# 最小 0 %、最大 100 % なので、古いタスクを止めてから新しいタスクを起こす。結果は「キー=値」の行で出す。
# 制約は外さずに残す（外すと、もう一度入れ替えが起きる）。次の aws/deploy.sh で、テンプレートの値（制約なし）に戻る
failover() {
  local old az ci host others expr kind new
  old=$(ecs list-tasks --cluster "$CLUSTER" --service-name spire-server --desired-status RUNNING --query 'taskArns[0]' --output text)
  read -r az ci < <(ecs describe-tasks --cluster "$CLUSTER" --tasks "$old" --query 'tasks[0].[availabilityZone,containerInstanceArn]' --output text)
  host=$(host_of "$ci")
  others=$(ecs list-container-instances --cluster "$CLUSTER" --filter "attribute:ecs.availability-zone != $az" --query 'length(containerInstanceArns)' --output text)
  if [ "$others" -gt 0 ]; then expr="attribute:ecs.availability-zone != $az"; kind=az; else expr="ec2InstanceId != $host"; kind=host; fi
  echo "old_task=${old##*/}"
  echo "old_az=$az"
  echo "old_host=$host"
  echo "kind=$kind"
  echo "requested_at_ms=$(($(date +%s) * 1000))"
  ecs update-service --cluster "$CLUSTER" --service spire-server --force-new-deployment \
    --placement-constraints "[{\"type\":\"memberOf\",\"expression\":\"$expr\"}]" >/dev/null
  until ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$old" 2>/dev/null; do :; done
  echo "old_stopped_at=$(ecs describe-tasks --cluster "$CLUSTER" --tasks "$old" --query 'tasks[0].stoppedAt' --output text)"
  new=None
  until [ "$new" != None ] && [ "$new" != "$old" ]; do
    sleep 5
    new=$(ecs list-tasks --cluster "$CLUSTER" --service-name spire-server --desired-status RUNNING --query 'taskArns[0]' --output text)
  done
  until ecs wait tasks-running --cluster "$CLUSTER" --tasks "$new" 2>/dev/null; do :; done
  read -r az ci < <(ecs describe-tasks --cluster "$CLUSTER" --tasks "$new" --query 'tasks[0].[availabilityZone,containerInstanceArn]' --output text)
  echo "new_task=${new##*/}"
  echo "new_az=$az"
  echo "new_host=$(host_of "$ci")"
  echo "new_started_at=$(ecs describe-tasks --cluster "$CLUSTER" --tasks "$new" --query 'tasks[0].startedAt' --output text)"
}

if [ "$MODE" = scenarios ]; then
  placement > "$DIR/placement.txt"
  echo "タスクの置き場所: $(awk '{print $1"@"$3}' "$DIR/placement.txt" | tr '\n' ' ')"
fi

# 1-b: 登録していないファミリーのタスク。確認役が 30 秒待って結果を出し、自分で止まる
if [ "$MODE" = scenarios ]; then
  ROGUE=$(ecs run-task --cluster "$CLUSTER" --capacity-provider-strategy "capacityProvider=$CP,weight=1" \
    --task-definition "$(out RogueTaskDefinition)" --query 'tasks[0].taskArn' --output text)
  echo "gekko13-rogue を起動した: ${ROGUE##*/}"
fi

START_MS=$(($(date +%s) * 1000))
# タスク数は 0 から 1 にするだけで、新しいデプロイを強制しない（強制すると、最初に起きたタスクが入れ替えられる。docs/findings.md）
for r in $ROLES; do ecs update-service --cluster "$CLUSTER" --service "probe-$r" --desired-count 1 >/dev/null; done
# サービスが安定してから、動いているタスクを取る。台が起きるのを待つことがあるので、services-stable を 3 回（30 分）まで繰り返す
PROBES=$(for r in $ROLES; do printf 'probe-%s ' "$r"; done)
for i in 1 2 3; do
  # shellcheck disable=SC2086
  ecs wait services-stable --cluster "$CLUSTER" --services $PROBES 2>/dev/null && break
  if [ "$i" = 3 ]; then echo "プローブのサービスが 30 分で安定しなかった" >&2; exit 1; fi
done

declare -A TASK
for r in $ROLES; do
  TASK[$r]=$(ecs list-tasks --cluster "$CLUSTER" --service-name "probe-$r" --desired-status RUNNING --query 'taskArns[0]' --output text)
  [ "${TASK[$r]}" != None ] || { echo "probe-$r のタスクが見つからない" >&2; exit 1; }
  echo "probe-$r を起動した: ${TASK[$r]##*/}"
done

if [ "$MODE" = failover ]; then
  ( sleep $((FAILOVER_AFTER * 60)); failover ) > "$DIR/failover.txt" 2>"$DIR/failover.err" &
  FO_PID=$!
  echo "$FAILOVER_AFTER 分後に、SPIRE server を移す"
fi

# 走り終えると、ログに PROBE_DONE と終了コードが出る。タスクはそのあと待ち続けるので、ログで終わりを知る
DEADLINE=$(($(date +%s) + WAIT_S))
for r in $ROLES; do
  until logs_of "probe-$r/probe/${TASK[$r]##*/}" > "$DIR/probe-$r.log" && grep -q '^PROBE_DONE ' "$DIR/probe-$r.log"; do
    STATUS=$(ecs describe-tasks --cluster "$CLUSTER" --tasks "${TASK[$r]}" --query 'tasks[0].[lastStatus,stoppedReason]' --output text)
    case "$STATUS" in STOPPED*) echo "probe-$r が止まった: $STATUS。ログ: $DIR/probe-$r.log" >&2; exit 1 ;; esac
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then echo "probe-$r が時間内に終わらなかった。ログ: $DIR/probe-$r.log" >&2; exit 1; fi
    sleep 15
  done
  echo "probe-$r が終わった（$(sed -n 's/^PROBE_DONE //p' "$DIR/probe-$r.log" | tail -1)）"
done
END_MS=$(($(date +%s) * 1000))

if [ "$MODE" = scenarios ]; then
  until ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$ROGUE" 2>/dev/null; do :; done
  logs_of "rogue/check/${ROGUE##*/}" > "$DIR/rogue.log"
  ROGUE=""
  node scripts/aws-collect.ts scenarios "$DIR/probe-bff.log" "$DIR/probe-transfer.log" "$DIR/probe-ledger.log" "$DIR/rogue.log" "$DIR/placement.txt"
else
  if [ "$MODE" = failover ]; then
    # 入れ替えが終わるのを待つ（試験より先に終わっているはず）
    wait "$FO_PID" || { echo "server の入れ替えに失敗した: $DIR/failover.err" >&2; exit 1; }
    FO_PID=""
    old=$(sed -n 's/^old_task=//p' "$DIR/failover.txt")
    new=$(sed -n 's/^new_task=//p' "$DIR/failover.txt")
    logs_with_time "spire-server/spire-server/$old" > "$DIR/server-old.log"
    logs_with_time "spire-server/spire-server/$new" > "$DIR/server-new.log"
    logs_with_time "spire-server/registrar/$new" > "$DIR/registrar-new.log"
    # 試験の間に止まった agent のタスク（server に届かずに止まったものを数える）
    stopped=$(ecs list-tasks --cluster "$CLUSTER" --service-name spire-agent --desired-status STOPPED --query 'taskArns' --output text)
    if [ -n "$stopped" ]; then
      # shellcheck disable=SC2086
      ecs describe-tasks --cluster "$CLUSTER" --tasks $stopped --query 'tasks[].[stoppedAt,stoppedReason]' --output text > "$DIR/agents-stopped.txt"
    else
      : > "$DIR/agents-stopped.txt"
    fi
    echo "start_ms=$START_MS" >> "$DIR/failover.txt"
    echo "end_ms=$(($(date +%s) * 1000))" >> "$DIR/failover.txt"
  fi
  # 本物のサービスの入れ替えを、アプリのログ（svid_rotated）から数える。1 件が「<サービス> <ログストリーム>」の 1 行
  : > "$DIR/rotations.txt"
  for s in bff transfer ledger; do
    aws logs filter-log-events --region "$REGION" --log-group-name "$LOGS" --log-stream-name-prefix "$s/app" \
      --start-time "$START_MS" --end-time "$END_MS" --filter-pattern '"svid_rotated"' \
      --query 'events[].logStreamName' --output text | tr '\t' '\n' | grep -v '^$' | sed "s|^|$s |" >> "$DIR/rotations.txt" || true
  done
  if [ "$MODE" = failover ]; then
    node scripts/aws-collect.ts failover "$DIR"
  else
    node scripts/aws-collect.ts soak "$DIR/probe-bff.log" "$DIR/rotations.txt"
  fi
fi
echo "ログ: $DIR/"
