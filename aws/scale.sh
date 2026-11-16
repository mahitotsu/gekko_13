#!/usr/bin/env bash
# AWS の段: 使わない間は down で、各サービスのタスク数を 0 にし、キャパシティプロバイダーに台を 0 まで縮めさせる。up で戻す。
# 台の数は、マネージドスケーリングが決める。ここでは ASG の台数を直接いじらない。
# SPIRE server の状態は EFS にあるので、台が入れ替わっても CA と登録は残る。
# 使い方:
#   aws/scale.sh down        タスクを 0 にして、台が 0 になるまで待つ（縮小には 15 分ほどかかる）
#   aws/scale.sh up [数]     server を 1、bff、transfer、ledger を「数」（既定 1）にして、安定するまで待つ
set -euo pipefail
REGION=${AWS_REGION:-ap-northeast-1}
MODE=${1:?up か down を渡す}
COUNT=${2:-1}
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name gekko13-ecs --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
CLUSTER=$(out ClusterName)
ASG=$(out AutoScalingGroupName)
set_count() { aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$1" --desired-count "$2" >/dev/null; }
hosts() { aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$ASG" --query 'length(AutoScalingGroups[0].Instances)' --output text; }

case "$MODE" in
  down)
    for s in probe-bff probe-transfer probe-ledger bff transfer ledger spire-server; do set_count "$s" 0; done
    echo "タスク数を 0 にした。台が 0 になるまで待つ（上限 40 分）"
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
    set_count spire-server 1
    for s in ledger transfer bff; do set_count "$s" "$COUNT"; done
    echo "タスク数を戻した。台が起き、サービスが安定するまで待つ"
    # services-stable は 10 分で切れる。台が起きるのに時間がかかるので、4 回（40 分）まで繰り返す
    for i in 1 2 3 4; do
      aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services spire-server ledger transfer bff 2>/dev/null && break
      if [ "$i" = 4 ]; then echo "40 分で安定しなかった。aws ecs describe-services の events を見る" >&2; exit 1; fi
    done
    echo "安定した（台 $(hosts) 台）"
    ;;
  *) echo "up か down を渡す: $MODE" >&2; exit 2 ;;
esac
