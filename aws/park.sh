#!/usr/bin/env bash
# 使わない間の固定費を止める。インスタンスを 0 にするだけでは、入口の ALB、Cloud Map のホストゾーン、アラーム、ECR のイメージの費用が残る。
# 順に、インスタンスを 0 にする → ディストリビューションを止めて ALB から切り離す（Parked=true）→ gekko13-apps → gekko13-ecs → gekko13-registry を消す。
# 残すもの: CloudFront のディストリビューション（止めたまま。名前と RP ID は変わらない）、gekko13-network（VPC と EFS。SPIRE の CA と登録が残る）、
#   Cognito（第 1 部）、SSM の引数。どれも固定費がないか、月 0.001 ドル未満。
# 戻すときは aws/deploy.sh を回す（イメージの作り直しと、VPC origin の作り直しで 30 分ほど。推定）。
# 消す操作は戻せない。回す前に、持ち主の承認を得る（CLAUDE.md）。
# 使い方: aws/park.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-ap-northeast-1}
PREFIX=gekko13
exists() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" >/dev/null 2>&1; }
delete() {
  exists "$1" || { echo "$1 はもうない"; return 0; }
  echo "$1 を消す"
  aws cloudformation delete-stack --region "$REGION" --stack-name "$1"
  aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$1"
  echo "$1 を消した"
}

if exists "$PREFIX-ecs"; then aws/scale.sh down; fi

# ディストリビューションが使っている VPC origin は消せず、VPC origin が指す ALB も消せない。先にディストリビューションを止めて、VPC origin を外す
echo "配信を止めて、ALB から切り離す（数分〜10 分ほど）"
aws cloudformation deploy --region "$REGION" --stack-name "$PREFIX-edge" --template-file aws/edge.yaml \
  --no-fail-on-empty-changeset --parameter-overrides "Parked=true" "AlbArn=" "AlbDnsName="

delete "$PREFIX-apps"
delete "$PREFIX-ecs"
delete "$PREFIX-registry"

# ECS の Container Insights が作るロググループは、スタックの外にできる（保存は 1 日。測ったときだけ中身がある）
aws logs delete-log-group --region "$REGION" --log-group-name "/aws/ecs/containerinsights/$PREFIX/performance" 2>/dev/null || true

# Service Connect が名前空間の中に作るサービスが残ると、名前空間（ホストゾーン、月 0.5 ドル）が消えずに残ることがある（docs/findings.md の 2-5）
left=$(aws servicediscovery list-namespaces --region "$REGION" --query "Namespaces[?Name=='svc.$PREFIX.internal'].Id" --output text)
if [ -n "$left" ]; then echo "名前空間 svc.$PREFIX.internal（$left）が残っている。月 0.5 ドルのホストゾーンが残るので、手で消す" >&2; exit 1; fi
echo "止めた。残る固定費は EFS の月 0.001 ドル未満だけ。戻すときは aws/deploy.sh を回す"
