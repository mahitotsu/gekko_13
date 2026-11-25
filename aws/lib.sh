#!/usr/bin/env bash
# タスク数の正本は、ecs、apps、flow の 3 つのスタックのパラメーター Running（判断 61）。
# それを読み、変え、確かめる処理。aws/scale.sh、aws/deploy.sh、aws/reset-keycloak.sh が読み込む（それだけでは動かさない）。
# タスク数を update-service や register-scalable-target で直接変えない。スタックとずれ、あとの更新がつまずく（docs/findings.md の 5-21 と 5-27）。
REGION=${AWS_REGION:-ap-northeast-1}
PREFIX=gekko13
RUN_STACKS="$PREFIX-ecs $PREFIX-apps $PREFIX-flow"

out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
stack_status() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" --query 'Stacks[0].StackStatus' --output text; }
param_of() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" --query "Stacks[0].Parameters[?ParameterKey=='$2'].ParameterValue" --output text; }

# スタックの Running。true か false。パラメーターがまだなければ none、スタックがなければ absent
running_of() {
  local err v
  if ! v=$(param_of "$1" Running 2>&1); then
    err=$v
    case "$err" in *"does not exist"*) echo absent; return 0 ;; esac
    echo "$err" >&2; return 1
  fi
  case "$v" in true | false) echo "$v" ;; ""|None) echo none ;; *) echo "$1 の Running が読めない: $v" >&2; return 1 ;; esac
}

# 更新してよい状態か。どれか 1 つでも更新中や失敗のままなら、何も変えずに止める
check_ready() {
  local s st bad=0
  for s in "$@"; do
    st=$(stack_status "$s") || return 1
    case "$st" in
      CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE) ;;
      *) echo "$s は $st なので、変えない" >&2; bad=1 ;;
    esac
  done
  return $bad
}

# set_running <true|false> <スタック…>。Running だけを変える。テンプレートとほかのパラメーターは、スタックの今のものを使う
# （手元のテンプレートの変更を、知らないうちに送らない）。受け付けられるまでで戻る。終わりは wait_stacks で待つ
set_running() {
  local want=$1 s cur params args=() todo=()
  shift
  check_ready "$@" || return 1
  for s in "$@"; do
    cur=$(running_of "$s") || return 1
    case "$cur" in
      none | absent) echo "$s に Running がない。先に aws/deploy.sh を回す" >&2; return 1 ;;
      "$want") ;;
      *) todo+=("$s") ;;
    esac
  done
  for s in "${todo[@]}"; do
    params=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$s" \
      --query 'Stacks[0].Parameters[].ParameterKey' --output text) || return 1
    args=()
    local k
    for k in $params; do
      [ "$k" = Running ] || args+=("ParameterKey=$k,UsePreviousValue=true")
    done
    aws cloudformation update-stack --region "$REGION" --stack-name "$s" --use-previous-template \
      --capabilities CAPABILITY_IAM --parameters "${args[@]}" "ParameterKey=Running,ParameterValue=$want" >/dev/null || return 1
    echo "$s の Running を $want にする更新を始めた"
  done
}

# 更新が終わるまで待つ（上限 40 分）。戻されたら失敗にする
wait_stacks() {
  local deadline=$(($(date +%s) + 2400)) s st
  for s in "$@"; do
    while :; do
      st=$(stack_status "$s") || return 1
      case "$st" in
        CREATE_COMPLETE | UPDATE_COMPLETE) break ;;
        UPDATE_IN_PROGRESS | UPDATE_COMPLETE_CLEANUP_IN_PROGRESS) ;;
        *) echo "$s が $st になった。aws cloudformation describe-stack-events --stack-name $s を見る" >&2; return 1 ;;
      esac
      [ "$(date +%s)" -lt "$deadline" ] || { echo "$s が 40 分で終わらなかった（$st）" >&2; return 1; }
      sleep 10
    done
  done
}

# DAEMON（spire-agent）以外のサービスを「名前 希望 実行中 待機中」の行で出す。describe-services は一度に 10 個まで
service_counts() {
  local arns
  arns=$(aws ecs list-services --region "$REGION" --cluster "$1" --query 'serviceArns' --output text) || return 1
  [ -n "$arns" ] && [ "$arns" != None ] || return 0
  # shellcheck disable=SC2086
  printf '%s\n' $arns | xargs -n 10 aws ecs describe-services --region "$REGION" --cluster "$1" \
    --query 'services[?status==`ACTIVE` && schedulingStrategy==`REPLICA`].[serviceName,desiredCount,runningCount,pendingCount]' --output text --services
}

# verify_counts <true|false> <クラスター>。実際のタスク数が Running と合っているか。
# true は、どのサービスも希望が 2 以上で、その数だけ動いている。false は、希望も実行中も待機中も 0。
# CloudFormation は、値が変わらなければ何もしないので、直接変えられたずれは、ここで見つける
verify_counts() {
  local rows bad
  rows=$(service_counts "$2") || return 1
  [ -n "$rows" ] || { echo "サービスが 1 つもない" >&2; return 1; }
  bad=$(awk -v want="$1" 'want=="true" ? ($2<2 || $3!=$2) : ($2+$3+$4>0)' <<<"$rows")
  [ -z "$bad" ] || { printf 'タスク数が Running=%s と合わない（名前 希望 実行中 待機中）:\n%s\n' "$1" "$bad" >&2; return 1; }
}

# deploy.sh が渡す Running を決めて出す。3 つのスタックがそろい、実際のタスク数とも合っていなければ止める（0 台のまま true で送ると、
# デプロイメントが終わらない。findings 5-27）。Running のない古いスタックは、タスクが 0 のときだけ false とみなす。何もなければ false
deploy_running() {
  local s v seen="" cluster
  for s in $RUN_STACKS; do
    v=$(running_of "$s") || return 1
    [ "$v" = absent ] || seen="$seen $v"
  done
  seen=$(printf '%s\n' $seen | sort -u | tr '\n' ' ')
  case "$seen" in
    "" | " ") echo false; return 0 ;;
    "true " | "false ") v=${seen% } ;;
    "none " | "false none ") v=false ;;
    *) echo "スタックの Running がそろっていない（$seen）。aws/scale.sh up か down でそろえる" >&2; return 1 ;;
  esac
  cluster=$(out "$PREFIX-ecs" ClusterName) || return 1
  if [ -n "$(service_counts "$cluster")" ]; then
    verify_counts "$v" "$cluster" || { echo "deploy の前に、タスク数をそろえる（aws/scale.sh up か down）" >&2; return 1; }
  fi
  echo "$v"
}
