#!/usr/bin/env bash
# 段 D の D1-a3: 流れの途中でインスタンスを 1 台、予告なしに止め（スポットの中断より厳しい条件）、主の流れが続くかを見る（plan.md の 4-3 の D1-a3 の予測）。
#   1. CloudFront を通して、主の流れ（scripts/ui-flow.ts）を、案の提示のあとで待たせる（PAUSE_FILE）。
#   2. その会話の案の提示を出した営業 AI エージェントのタスク（CloudWatch Logs のログストリームで決める）が載ったインスタンスを止める。
#      同じ台の顧客のアプリのタスクも、一緒に止まる（載っていたタスクを記録する）。
#   3. 5 秒待ってから、続きを進めさせ、ログインし直さずに照合と監査まで通るかを見る。
#   4. 止める前から 2 秒ごとに、CloudFront を通して、顧客のアプリの /config.json と Keycloak の discovery を呼び、失敗の数と時刻を取る。
#   5. 止めてから 60 秒後に、新しく始めた主の流れも通るかを見る。
# 結果は local/run/d1a3-failover/ に書く（local/down.sh で消えるので、残すものは先に写す）。
# 使い方: aws/d1a3-failover.sh [止めたあとに入口を見る秒（既定 480）]
# 前提: 全部のサービスが 2 タスクで安定している。実行すると費用が出る。ASG が代わりのインスタンスを起動する。
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-ap-northeast-1}
WATCH=${1:-480}
stack_out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
CLUSTER=$(stack_out gekko13-ecs ClusterName)
LOG_GROUP=$(stack_out gekko13-ecs LogGroupName)
DOMAIN=$(stack_out gekko13-edge DomainName)
DEMO_PASSWORD=$(aws ssm get-parameter --region "$REGION" --name /gekko13/login/demo-password --with-decryption --query Parameter.Value --output text)
export DEMO_PASSWORD
RUN=local/run/d1a3-failover/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$RUN"
GO=$RUN/go

# 2 秒ごとに入口を呼ぶ。行は「時刻（UNIX 秒） 種類 状態」
probe() {
  while :; do
    t=$(date +%s)
    a=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/config.json" || echo 000)
    k=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/login/realms/insurer/.well-known/openid-configuration" || echo 000)
    echo "$t app $a"
    echo "$t login $k"
    sleep 2
  done
}
probe > "$RUN/probe.txt" &
PROBE=$!
trap 'kill $PROBE 2>/dev/null || true' EXIT

# 1. 案の提示のあとで待たせる
S=$(date +%s)
PAUSE_FILE=$GO timeout 600 node scripts/ui-flow.ts "https://$DOMAIN" > "$RUN/flow.log" 2>&1 &
FLOW=$!
for _ in $(seq 1 180); do grep -q "待つ" "$RUN/flow.log" 2>/dev/null && break; sleep 1; done
grep -q "待つ" "$RUN/flow.log" || { echo "案の提示まで進まなかった" >&2; cat "$RUN/flow.log" >&2; exit 1; }

# 2. 案の提示を出したタスク。awslogs のログストリームは sales-agent/app/<タスクの ID>
# CloudWatch Logs に届くまで、数秒かかる。60 秒まで待つ
TASK=
for _ in $(seq 1 12); do
  sleep 5
  STREAM=$(aws logs filter-log-events --region "$REGION" --log-group-name "$LOG_GROUP" --log-stream-name-prefix sales-agent/app \
    --filter-pattern '"present_offers"' --start-time "$((S * 1000))" --query 'events[].logStreamName' --output text |
    tr -s '\t ' '\n' | grep '^sales-agent/' | tail -1 || true)
  # CLI はページごとに --query を当てるので、ページの数だけ行が出る（空のページは None）。ストリームの名前だけを取る
  TASK=${STREAM##*/}
  [ -z "$TASK" ] || [ "$TASK" = None ] || break
done
[ -n "$TASK" ] && [ "$TASK" != None ] || { echo "案の提示を出したタスクが見つからない" >&2; exit 1; }
CI=$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containerInstanceArn' --output text)
VICTIM=$(aws ecs describe-container-instances --region "$REGION" --cluster "$CLUSTER" --container-instances "$CI" --query 'containerInstances[0].ec2InstanceId' --output text)
AZ=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$VICTIM" --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)
aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" --container-instance "$CI" --query 'taskArns' --output text |
  xargs -r -n 100 aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --query 'tasks[].group' --output text --tasks |
  tr '\t' '\n' | sed 's/^service://' | sort | uniq -c > "$RUN/victim-tasks.txt"
echo "案の提示を出したタスク: $TASK。止める台: $AZ の 1 台。載っているタスク:"; sed 's/^/  /' "$RUN/victim-tasks.txt"

T0=$(date +%s)
aws ec2 terminate-instances --region "$REGION" --instance-ids "$VICTIM" >/dev/null
echo "始点: 台を止めた（$(date -u -d "@$T0" +%H:%M:%SZ)）"

# 3. 5 秒後に続きを進めさせる
sleep 5
touch "$GO"
FLOW_OK=no
wait "$FLOW" && FLOW_OK=yes
echo "止めたあとの続き: $FLOW_OK"
grep -E '"ok":false|判定|食い違い' "$RUN/flow.log" | cut -c1-200

# 5. 止めてから 60 秒後に、新しく始めた主の流れ
while [ "$(date +%s)" -lt $((T0 + 60)) ]; do sleep 2; done
NEW_OK=no
timeout 300 node scripts/ui-flow.ts "https://$DOMAIN" > "$RUN/flow-new.log" 2>&1 && NEW_OK=yes
echo "止めたあとに新しく始めた流れ: $NEW_OK"

while [ "$(date +%s)" -lt $((T0 + WATCH)) ]; do sleep 5; done
kill $PROBE 2>/dev/null || true

summary() {
  awk -v kind="$1" -v t0="$T0" '$2 == kind && $1 >= t0 { n++; if ($3 != "200") { f++; if (first == "") first = $1 - t0; last = $1 - t0 } }
    END { printf "| %s | %d | %d | %s | %s |\n", kind, n, f, (first == "" ? "-" : first), (last == "" ? "-" : last) }' "$RUN/probe.txt"
}
{
  echo "# 流れの途中で台を 1 台止めた $(basename "$RUN")"
  echo
  echo "案の提示を出したタスク: $TASK。止めた台の AZ: $AZ。載っていたタスク: $(awk '{printf "%s×%s ", $2, $1}' "$RUN/victim-tasks.txt")"
  echo
  echo "- 止めたあとの続き（ログインし直さずに照合と監査まで）: $FLOW_OK"
  echo "- 止めてから 60 秒後に新しく始めた流れ: $NEW_OK"
  echo
  echo "| 呼んだもの | 呼んだ数 | 失敗の数 | 最初の失敗（秒） | 最後の失敗（秒） |"
  echo "|---|---|---|---|---|"
  summary app
  summary login
} | tee "$RUN/result.md"
echo "結果: $RUN/result.md（local/down.sh で消えるので、残すものは先に写す）"
