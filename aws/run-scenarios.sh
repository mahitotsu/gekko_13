#!/usr/bin/env bash
# AWS の段: シナリオを ECS のタスク gekko13-probe として回し、ログから結果を拾って local/run/ に置く。
# 前提: aws/deploy.sh で作り、aws/create-user.sh と node scripts/aws-login.ts を済ませた（リフレッシュトークンは 60 分で切れる）。
# 使い方:
#   aws/run-scenarios.sh            シナリオ（1-a、1-b、3-a〜3-g）
#   aws/run-scenarios.sh soak 30    入れ替えの試験を 30 分
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-ap-northeast-1}
MODE=${1:-scenarios}
MINUTES=${2:-30}
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name gekko13-ecs --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
CLUSTER=$(out ClusterName)
LOGS=$(out LogGroupName)
mkdir -p local/run
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)

run_task() { aws ecs run-task --region "$REGION" --cluster "$CLUSTER" --launch-type EC2 --task-definition "$1" "${@:2}" --query 'tasks[0].taskArn' --output text; }

ROGUE=""
if [ "$MODE" = scenarios ]; then
  # 1-b: 登録していないファミリーの svid-helper を先に動かし、SVID を待たせる
  ROGUE=$(run_task "$(out RogueTaskDefinition)")
  aws ecs wait tasks-running --region "$REGION" --cluster "$CLUSTER" --tasks "$ROGUE"
  echo "gekko13-rogue を起動した。30 秒待つ"
  sleep 30
  PROBE=$(run_task "$(out ProbeTaskDefinition)")
else
  OVERRIDE=$(printf '{"containerOverrides":[{"name":"probe","command":["node","scripts/soak.ts","--target","aws","--minutes","%s"]}]}' "$MINUTES")
  PROBE=$(run_task "$(out ProbeTaskDefinition)" --overrides "$OVERRIDE")
fi
echo "実行役を起動した: ${PROBE##*/}"

# 入れ替えの試験は 30 分を超える。待つ上限（10 分ごとに 1 回の待ち）を繰り返す
until aws ecs wait tasks-stopped --region "$REGION" --cluster "$CLUSTER" --tasks "$PROBE" 2>/dev/null; do :; done
[ -n "$ROGUE" ] && aws ecs stop-task --region "$REGION" --cluster "$CLUSTER" --task "$ROGUE" >/dev/null

CODE=$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$PROBE" --query 'tasks[0].containers[0].exitCode' --output text)
LOG=local/run/aws-$MODE-$STAMP.log
aws logs get-log-events --region "$REGION" --log-group-name "$LOGS" --log-stream-name "probe/probe/${PROBE##*/}" \
  --start-from-head --query 'events[].message' --output text | tr '\t' '\n' > "$LOG"
grep -E '^(PASS|FAIL|SKIP) |件が期待どおり|RESULT ' "$LOG" | sed 's/^RESULT .\{0,200\}.*/RESULT（全文はログ）/' || true
echo "終了コード $CODE。ログ: $LOG"
[ "$CODE" = 0 ]
