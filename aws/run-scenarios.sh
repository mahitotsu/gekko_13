#!/usr/bin/env bash
# AWS の段: シナリオを、プローブの 3 つの役（probe-bff、probe-transfer、probe-ledger。普段はタスク数 0）として回す。
# 各役は、本物のファミリーのタスクとして自分の SVID を得て、Service Connect の中から攻撃する（「乗っ取られたタスク」）。
# 試験の間だけタスク数を 1 にし、終わったら必ず 0 に戻す。結果は scripts/aws-collect.ts がまとめ、local/run/ に置く。
# どの台にプローブが置かれてもよい（台の数と配置に依らない）。
# 前提: aws/deploy.sh で作り、aws/scale.sh up で動かし、aws/create-user.sh と node scripts/aws-login.ts を済ませた
#       （リフレッシュトークンは 60 分で切れる）。
# 使い方:
#   aws/run-scenarios.sh            シナリオ（1-a、1-b、3-a〜3-g）
#   aws/run-scenarios.sh soak 30    入れ替えの試験を 30 分（probe-bff だけが連鎖を呼び続ける）
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-ap-northeast-1}
MODE=${1:-scenarios}
MINUTES=${2:-30}
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
  soak) PROBE_MODE="soak $MINUTES"; ROLES="bff"; WAIT_S=$((MINUTES * 60 + 900)) ;;
  *) echo "scenarios か soak を渡す: $MODE" >&2; exit 2 ;;
esac
# プローブは、起動のときにこの値を環境変数 PROBE_MODE として受け取る
aws ssm put-parameter --region "$REGION" --name /gekko13/probe/mode --type String --overwrite --value "$PROBE_MODE" >/dev/null

ROGUE=""
cleanup() {
  for r in bff transfer ledger; do ecs update-service --cluster "$CLUSTER" --service "probe-$r" --desired-count 0 >/dev/null || true; done
  if [ -n "$ROGUE" ]; then ecs stop-task --cluster "$CLUSTER" --task "$ROGUE" >/dev/null 2>&1 || true; fi
  echo "プローブのタスク数を 0 に戻した"
}
trap cleanup EXIT

logs_of() {
  aws logs get-log-events --region "$REGION" --log-group-name "$LOGS" --log-stream-name "$1" \
    --start-from-head --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n'
}

# 1-b: 登録していないファミリーのタスク。確認役が 30 秒待って結果を出し、自分で止まる
if [ "$MODE" = scenarios ]; then
  ROGUE=$(ecs run-task --cluster "$CLUSTER" --capacity-provider-strategy "capacityProvider=$CP,weight=1" \
    --task-definition "$(out RogueTaskDefinition)" --query 'tasks[0].taskArn' --output text)
  echo "gekko13-rogue を起動した: ${ROGUE##*/}"
fi

START_MS=$(($(date +%s) * 1000))
for r in $ROLES; do ecs update-service --cluster "$CLUSTER" --service "probe-$r" --desired-count 1 --force-new-deployment >/dev/null; done

declare -A TASK
for r in $ROLES; do
  TASK[$r]=None
  until [ "${TASK[$r]}" != None ]; do
    sleep 5
    TASK[$r]=$(ecs list-tasks --cluster "$CLUSTER" --service-name "probe-$r" --desired-status RUNNING --query 'taskArns[0]' --output text)
  done
  echo "probe-$r を起動した: ${TASK[$r]##*/}"
done

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
  node scripts/aws-collect.ts scenarios "$DIR/probe-bff.log" "$DIR/probe-transfer.log" "$DIR/probe-ledger.log" "$DIR/rogue.log"
else
  # 本物のサービスの入れ替えを、アプリのログ（svid_rotated）から数える。1 件が「<サービス> <ログストリーム>」の 1 行
  : > "$DIR/rotations.txt"
  for s in bff transfer ledger; do
    aws logs filter-log-events --region "$REGION" --log-group-name "$LOGS" --log-stream-name-prefix "$s/app" \
      --start-time "$START_MS" --end-time "$END_MS" --filter-pattern '"svid_rotated"' \
      --query 'events[].logStreamName' --output text | tr '\t' '\n' | grep -v '^$' | sed "s|^|$s |" >> "$DIR/rotations.txt" || true
  done
  node scripts/aws-collect.ts soak "$DIR/probe-bff.log" "$DIR/rotations.txt"
fi
echo "ログ: $DIR/"
