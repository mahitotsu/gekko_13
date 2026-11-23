#!/usr/bin/env bash
# AWS の段: 使わない間は down で、各サービスのタスク数を 0 にし、キャパシティプロバイダーにインスタンスを 0 まで縮めさせる。up で戻す。
# インスタンスの数は、マネージドスケーリングが決める。down のときだけ、タスクが 0 になってから ASG の希望台数を直接 0 にする
# （マネージドスケーリングの縮小は、アラームが 15 分待つため。docs/findings.md）。
# SPIRE server の状態は EFS にあるので、インスタンスが入れ替わっても CA と登録は残る。入口のリバースプロキシは名前空間の SRV で送り先を見つけるので、向け直しは要らない。
# 使い方:
#   aws/scale.sh down        DAEMON 以外の全サービスを 0 にし、ASG の希望台数も 0 にして、インスタンスが 0 になるまで待つ（数分）
#   aws/scale.sh up          全部のサービス（spire-server、auth、keycloak と、主の流れの customer-app、sales-agent、insurer-mcp、
#                            insurer-backend、insurer-audit）を 2 にして、安定するまで待つ（段 D の D1-a3。判断 56）。
#                            タスクのオートスケーリングがあれば（apps のスタックの EnableAutoScaling）、最小 2、最大 4 に戻す
#   GEKKO13_NO_WAIT=1 を付けると、up はタスク数を戻すだけで待たない（測るスクリプトが、自分で時刻を取るため）
set -euo pipefail
REGION=${AWS_REGION:-ap-northeast-1}
MODE=${1:?up か down を渡す}
UP_SERVICES="spire-server auth keycloak customer-app sales-agent insurer-mcp insurer-backend insurer-audit"
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name gekko13-ecs --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
CLUSTER=$(out ClusterName)
ASG=$(out AutoScalingGroupName)
set_count() { aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$1" --desired-count "$2" >/dev/null; }
# タスクのオートスケーリング（段 D の D1-a1。apps のスタック）の幅を変える。止めるときは 0 にしないと、オートスケーリングが最小の 2 に戻してしまう。
# 既定ではオートスケーリングを作らない（判断 56）。ターゲットがあるサービスだけを変える（ないサービスを登録すると、新しく作ってしまう）
AUTOSCALED="keycloak auth"
has_target() {
  [ "$(aws application-autoscaling describe-scalable-targets --region "$REGION" --service-namespace ecs \
    --resource-ids "service/$CLUSTER/$1" --query 'length(ScalableTargets)' --output text)" != 0 ]
}
set_range() {
  for s in $AUTOSCALED; do
    has_target "$s" || continue
    aws application-autoscaling register-scalable-target --region "$REGION" --service-namespace ecs \
      --scalable-dimension ecs:service:DesiredCount --resource-id "service/$CLUSTER/$s" --min-capacity "$1" --max-capacity "$2" >/dev/null
  done
}
hosts() { aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$ASG" --query 'length(AutoScalingGroups[0].Instances)' --output text; }
# DAEMON（spire-agent）以外の、動いているサービスの名前。どのスタックのサービスでも、ここで拾う
replica_services() {
  local arns
  arns=$(aws ecs list-services --region "$REGION" --cluster "$CLUSTER" --query 'serviceArns' --output text)
  [ -n "$arns" ] && [ "$arns" != None ] || return 0
  # describe-services は一度に 10 個まで
  # shellcheck disable=SC2086
  printf '%s\n' $arns | xargs -n 10 aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" \
    --query 'services[?status==`ACTIVE` && schedulingStrategy==`REPLICA`].serviceName' --output text --services | tr '\t\n' '  '
}

case "$MODE" in
  down)
    set_range 0 0
    SERVICES_DOWN=$(replica_services)
    for s in $SERVICES_DOWN; do set_count "$s" 0; done
    echo "タスク数を 0 にした（$SERVICES_DOWN）。DAEMON 以外のタスクが止まるまで待つ"
    # shellcheck disable=SC2086
    [ -z "$SERVICES_DOWN" ] || aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services $SERVICES_DOWN
    # マネージドスケーリングに任せると、縮小のアラームが 15 分待つ。タスクが 0 なら、希望台数を直接 0 にして待ちを省く。
    # 終了保護は切ってあり、マネージドドレインがあるので、タスクを巻き込まない。DAEMON 以外が残っていれば、0 にしない
    LEFT=$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" --desired-status RUNNING --query 'taskArns' --output text | wc -w)
    AGENTS=$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" --service-name spire-agent --desired-status RUNNING --query 'taskArns' --output text | wc -w)
    if [ "$LEFT" -eq "$AGENTS" ]; then
      aws autoscaling set-desired-capacity --region "$REGION" --auto-scaling-group-name "$ASG" --desired-capacity 0
      echo "残りは agent（DAEMON）だけなので、ASG の希望台数を 0 にした"
    else
      echo "DAEMON 以外のタスクが $((LEFT - AGENTS)) 個残っている。希望台数は変えず、マネージドスケーリングに任せる" >&2
    fi
    echo "台が 0 になるまで待つ（上限 40 分）"
    DEADLINE=$(($(date +%s) + 2400))
    until [ "$(hosts)" = 0 ]; do
      if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "40 分で台が 0 にならなかった（残り $(hosts) 台）。docs/runbook.md の「つまずきやすい点」を見る" >&2
        exit 1
      fi
      sleep 30
    done
    echo "台が 0 になった"
    ;;
  up)
    # 幅を先に戻す。0 のままタスク数を 2 にすると、オートスケーリングが 0 に戻してしまう
    set_range 2 4
    # どのサービスも 2 タスク。状態は共有の Aurora にある（段 D の D1-a3。判断 56）
    for s in $UP_SERVICES; do set_count "$s" 2; done
    if [ "${GEKKO13_NO_WAIT:-}" = 1 ]; then echo "タスク数を戻した（待たない）"; exit 0; fi
    echo "タスク数を戻した。台が起き、サービスが安定するまで待つ"
    # services-stable は 10 分で切れる。インスタンスが起きるのに時間がかかるので、4 回（40 分）まで繰り返す
    for i in 1 2 3 4; do
      # shellcheck disable=SC2086
      aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services $UP_SERVICES 2>/dev/null && break
      if [ "$i" = 4 ]; then echo "40 分で安定しなかった。aws ecs describe-services の events を見る" >&2; exit 1; fi
    done
    echo "安定した（台 $(hosts) 台）"
    ;;
  *) echo "up か down を渡す: $MODE" >&2; exit 2 ;;
esac
