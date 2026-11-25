#!/usr/bin/env bash
# AWS の段: 使わない間は down で、各サービスのタスク数を 0 にし、インスタンスを 0 まで縮める。up で戻す。
# タスク数の正本は、ecs、apps、flow の 3 つのスタックのパラメーター Running（判断 61）。ここは Running だけを変え、テンプレートとほかの
# パラメーターはスタックの今のものを使う。3 つは並べて更新する（順に更新すると、CloudFormation が前のスタックの安定を待ち、使えるまでが延びる）。
# インスタンスの数は、マネージドスケーリングが決める。down のときだけ、タスクが 0 になってから ASG の希望台数を直接 0 にする
# （マネージドスケーリングの縮小は、アラームが 15 分待つため。判断 13）。
# SPIRE server の状態は Aurora にあるので、インスタンスが入れ替わっても CA と登録は残る。入口のリバースプロキシは名前空間の SRV で送り先を見つけるので、向け直しは要らない。
# AMI は SSM の値を参照しているので、新しくなっていれば、この更新で起動テンプレートも変わる（起きているインスタンスは替わらない。推定）。
# 使い方:
#   aws/scale.sh down        全部のサービスを 0 にし、ASG の希望台数も 0 にして、インスタンスが 0 になるまで待つ（数分）
#   aws/scale.sh up          全部のサービスを 2 にして、安定するまで待つ（オートスケーリングがあれば、幅を 2〜4 に戻す）
#   GEKKO13_NO_WAIT=1 を付けると、up は更新が受け付けられたら戻る（測るスクリプトが、自分で時刻を取るため）
#   スタックが更新中なら、何も変えずに止まる。GEKKO13_CANCEL=1 を付けた down は、更新を取り消して戻してから 0 にする
set -euo pipefail
cd "$(dirname "$0")/.."
MODE=${1:?up か down を渡す}
# shellcheck source=aws/lib.sh
. aws/lib.sh
CLUSTER=$(out "$PREFIX-ecs" ClusterName)
ASG=$(out "$PREFIX-ecs" AutoScalingGroupName)
hosts() { aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$ASG" --query 'length(AutoScalingGroups[0].Instances)' --output text; }
wait_until() { # wait_until <秒> <関数と引数…>
  local deadline=$(($(date +%s) + $1))
  shift
  until "$@" 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || { "$@"; return 1; }
    sleep 10
  done
}

case "$MODE" in
  down)
    if [ "${GEKKO13_CANCEL:-}" = 1 ]; then
      for s in $RUN_STACKS; do
        [ "$(stack_status "$s")" != UPDATE_IN_PROGRESS ] || { echo "$s の更新を取り消す"; aws cloudformation cancel-update-stack --region "$REGION" --stack-name "$s"; }
      done
      # shellcheck disable=SC2086
      wait_until 1800 check_ready $RUN_STACKS
    fi
    # shellcheck disable=SC2086
    set_running false $RUN_STACKS
    echo "Running を false にした。DAEMON 以外のタスクが止まるまで待つ"
    # shellcheck disable=SC2086
    wait_stacks $RUN_STACKS
    # オートスケーリングがあると、スタックの完了のあとで、幅に合わせて 0 になる
    wait_until 900 verify_counts false "$CLUSTER"
    aws autoscaling set-desired-capacity --region "$REGION" --auto-scaling-group-name "$ASG" --desired-capacity 0
    echo "残りは agent（DAEMON）だけなので、ASG の希望台数を 0 にした。台が 0 になるまで待つ（上限 40 分）"
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
    # shellcheck disable=SC2086
    set_running true $RUN_STACKS
    if [ "${GEKKO13_NO_WAIT:-}" = 1 ]; then echo "Running を true にした（待たない）"; exit 0; fi
    echo "Running を true にした。台が起き、サービスが安定するまで待つ"
    # shellcheck disable=SC2086
    wait_stacks $RUN_STACKS
    wait_until 900 verify_counts true "$CLUSTER"
    echo "安定した（台 $(hosts) 台）"
    ;;
  *) echo "up か down を渡す: $MODE" >&2; exit 2 ;;
esac
