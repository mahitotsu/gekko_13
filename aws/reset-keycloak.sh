#!/usr/bin/env bash
# AWS の Keycloak のデータベースを作り直し、レルムを取り込み直させる（レルムの JSON を直したとき。段 D の D1-a2）。
# レルムは「すでにあれば取り込まない」ので、データベースを消してから Keycloak を起こし直す。
# 消えるもの: Aurora の keycloak のデータベースの全部（利用者が登録したパスキー、ログインのセッション）。戻せない。
# 動かす前に、持ち主に対象を見せて承認を得る（CLAUDE.md の「承認が要る操作」）。インスタンスが動いている間に回す。
# 手順: Keycloak と auth のタスクを 0 にする（apps のスタックの Running）→ 一度だけのタスク（db-init のイメージ）で DROP と CREATE → タスクの定義を外す → Running を戻す。
# 使い方: aws/reset-keycloak.sh --yes
set -euo pipefail
cd "$(dirname "$0")/.."
[ "${1:-}" = --yes ] || { echo "消す操作なので、--yes を付けて回す（持ち主の承認のあと）" >&2; exit 2; }
# shellcheck source=aws/lib.sh
. aws/lib.sh
param() { param_of "$@"; }
CLUSTER=$(out "$PREFIX-ecs" ClusterName)
ROLE=$(out "$PREFIX-ecs" ExecutionRoleArn)
LOGS=$(out "$PREFIX-ecs" LogGroupName)
DB_HOST=$(out "$PREFIX-db" DbHost)
IMAGE=$(param "$PREFIX-ecs" DbInitImage)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ssm() { echo "arn:aws:ssm:$REGION:$ACCOUNT:parameter$1"; }

# Keycloak は apps のスタックにあるので、同じスタックの auth も一緒に止まる。ほかのスタックは動かしたまま（run-task の台が要る）
for s in $RUN_STACKS; do
  [ "$(running_of "$s")" = true ] || { echo "$s の Running が true でない。aws/scale.sh up のあとで回す" >&2; exit 1; }
done
# データベースを消す前の確かめなので、2 つとも見えて、どちらも 0 のときだけ通す
stopped() { service_counts "$CLUSTER" | awk '($1=="keycloak" || $1=="auth") {seen++; if ($2+$3+$4>0) n=1} END {exit (n || seen!=2)}'; }
echo "Keycloak と auth のタスクを 0 にする"
set_running false "$PREFIX-apps"
wait_stacks "$PREFIX-apps"
for i in $(seq 1 60); do stopped && break; sleep 10; done
stopped || { echo "Keycloak と auth が 10 分で 0 にならなかった。データベースは消していない" >&2; exit 1; }

SQL='printf "%s\n" "$DB_CA_PEM" > /tmp/ca.pem && PGPASSWORD="$DB_ADMIN_PASSWORD" psql "host=$DB_HOST port=5432 dbname=postgres user=$DB_ADMIN_USER sslmode=verify-full sslrootcert=/tmp/ca.pem" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS keycloak WITH (FORCE)" -c "CREATE DATABASE keycloak OWNER keycloak" && echo "keycloak のデータベースを作り直した"'
DEF=$(cat <<EOF
{"family":"$PREFIX-keycloak-reset","requiresCompatibilities":["EC2"],"networkMode":"bridge","executionRoleArn":"$ROLE",
 "containerDefinitions":[{"name":"reset","image":"$IMAGE","essential":true,"memoryReservation":32,
  "entryPoint":["sh","-c"],"command":[$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$SQL")],
  "environment":[{"name":"DB_HOST","value":"$DB_HOST"},{"name":"DB_ADMIN_USER","value":"$(param "$PREFIX-ecs" DbAdminUser)"}],
  "secrets":[{"name":"DB_ADMIN_PASSWORD","valueFrom":"$(ssm "/$PREFIX/db/master-password")"},{"name":"DB_CA_PEM","valueFrom":"$(ssm "/$PREFIX/db/ca")"}],
  "logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"$LOGS","awslogs-region":"$REGION","awslogs-stream-prefix":"keycloak-reset"}}}]}
EOF
)
TD=$(aws ecs register-task-definition --region "$REGION" --cli-input-json "$DEF" --query taskDefinition.taskDefinitionArn --output text)
TASK=$(aws ecs run-task --region "$REGION" --cluster "$CLUSTER" --task-definition "$TD" \
  --capacity-provider-strategy "capacityProvider=$(out "$PREFIX-ecs" CapacityProviderName),weight=1" --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK"
CODE=$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text)
aws ecs deregister-task-definition --region "$REGION" --task-definition "$TD" >/dev/null
[ "$CODE" = 0 ] || { echo "作り直しのタスクが失敗した（exit $CODE）。CloudWatch Logs の keycloak-reset を見る。Keycloak と auth は 0 のまま（aws/scale.sh up で戻る）" >&2; exit 1; }

echo "Keycloak と auth を戻す（レルムを取り込み直す）"
set_running true "$PREFIX-apps"
wait_stacks "$PREFIX-apps"
aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services keycloak auth
verify_counts true "$CLUSTER"
echo "終わった"
