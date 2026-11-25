#!/usr/bin/env bash
# aws/lib.sh と aws/scale.sh の試験（段 4、判断 61）。aws を偽物に差し替え、AWS には触れない。
set -euo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "${T:?}"' EXIT
mkdir "$T/bin"
# 偽の aws: スタックの状態と Running は $T/<スタック>.status と .running、タスク数は $T/counts、呼び出しは $T/calls
cat > "$T/bin/aws" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$T/calls"
arg() { local w=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$w" ] && { echo "$2"; return; }; shift; done; }
s=$(arg --stack-name "$@"); q=$(arg --query "$@")
case "$1 $2" in
  "cloudformation describe-stacks")
    [ -e "$T/$s.status" ] || { echo "Stack with id $s does not exist" >&2; exit 254; }
    case "$q" in
      *StackStatus*) cat "$T/$s.status" ;;
      *"'Running'"*) cat "$T/$s.running" ;;
      *Parameters*ParameterKey) printf 'Prefix\tAmiId\tRunning\n' ;;
      *Outputs*) echo gekko13 ;;
    esac ;;
  "cloudformation update-stack")
    v=$(grep -oE 'ParameterKey=Running,ParameterValue=[a-z]+' <<<"$*" | cut -d= -f3); echo "$v" > "$T/$s.running"
    awk -v n="$([ "$v" = true ] && echo 2 || echo 0)" '{print $1,n,n,0}' "$T/counts" > "$T/c2" && mv "$T/c2" "$T/counts" ;;
  "cloudformation cancel-update-stack") echo UPDATE_ROLLBACK_COMPLETE > "$T/$s.status" ;;
  "ecs list-services") echo arn:x ;;
  "ecs describe-services") cat "$T/counts" ;;
  "autoscaling describe-auto-scaling-groups") echo 0 ;;
esac
FAKE
chmod +x "$T/bin/aws"; export T PATH="$T/bin:$PATH"
setup() { # setup <Running> <タスク数>。Running が - なら、パラメーターのないスタック
  rm -f "$T"/*.status "$T"/*.running "$T/calls"; : > "$T/calls"
  for s in ecs apps flow; do echo UPDATE_COMPLETE > "$T/gekko13-$s.status"; { [ "$1" = - ] && echo None || echo "$1"; } > "$T/gekko13-$s.running"; done
  printf 'keycloak %s %s 0\nauth %s %s 0\n' "$2" "$2" "$2" "$2" > "$T/counts"
}
N=0
ok() { N=$((N + 1)); echo "ok $N $1"; }
fail() { echo "NG: $1" >&2; cat "$T/calls" >&2; exit 1; }
updates() { grep -c 'cloudformation update-stack' "$T/calls" || true; }
dr() { bash -c 'set -euo pipefail; . aws/lib.sh; RUNNING=$(deploy_running); echo "$RUNNING"' 2>"$T/err"; }

setup false 0; aws/scale.sh up >/dev/null 2>"$T/err" || fail "up"
[ "$(updates)" = 3 ] || fail "up は 3 つのスタックを変える"
[ "$(grep 'update-stack' "$T/calls" | grep -c -- '--use-previous-template.*ParameterKey=Prefix,UsePreviousValue=true ParameterKey=AmiId,UsePreviousValue=true ParameterKey=Running,ParameterValue=true')" = 3 ] || fail "Running のほかは前の値"
ok "up は、前のテンプレートと前の値で、Running だけを変える"
setup true 2; aws/scale.sh down >/dev/null 2>"$T/err" || fail "down"
[ "$(updates)" = 3 ] && grep -q 'set-desired-capacity.*--desired-capacity 0' "$T/calls" || fail "down"
! grep -qE 'update-service|register-scalable-target' "$T/calls" || fail "タスク数を直接変えた"
ok "down は Running を変え、ASG を 0 にし、タスク数を直接変えない"
setup true 2; echo UPDATE_IN_PROGRESS > "$T/gekko13-flow.status"
! aws/scale.sh down >/dev/null 2>"$T/err" || fail "更新中なのに進んだ"; [ "$(updates)" = 0 ] || fail "更新中なのに変えた"
! grep -q set-desired-capacity "$T/calls" || fail "更新中なのに台を 0 にした"
ok "1 つでも更新中なら、どれも変えない"
setup false 0; echo true > "$T/gekko13-ecs.running"; echo true > "$T/gekko13-apps.running"; aws/scale.sh up >/dev/null 2>"$T/err" || fail "途中から"
[ "$(updates)" = 1 ] || fail "同じ値は飛ばす"; ok "そろっていないときは、違うスタックだけを変える"
setup - 0; ! aws/scale.sh up >/dev/null 2>"$T/err" || fail "Running がない"; [ "$(updates)" = 0 ] || fail "変えた"; ok "Running がないスタックでは、変えずに止まる"
setup false 0; [ "$(dr)" = false ] || fail dr; ok "deploy: 0 台なら false"
setup true 2; [ "$(dr)" = true ] || fail dr; ok "deploy: 動いていれば true"
setup true 0; ! dr >/dev/null || fail "ずれ"; ok "deploy: true なのにタスクがなければ止まる（5-27）"
setup - 0; [ "$(dr)" = false ] || fail dr; ok "deploy: Running がなく、タスクも 0 なら false"
setup - 2; ! dr >/dev/null || fail "移行"; ok "deploy: Running がなく、タスクがあれば止まる"
setup false 0; echo true > "$T/gekko13-apps.running"; ! dr >/dev/null || fail "混在"; ok "deploy: そろっていなければ止まる"
setup false 0; rm "$T"/*.status; [ "$(dr)" = false ] || fail "新規"; ok "deploy: 何もなければ false"
setup true 2; sed -i 's/^auth 2 2/auth 2 1/' "$T/counts"; ! bash -c '. aws/lib.sh; verify_counts true gekko13' 2>/dev/null || fail "足りない"; ok "実行中が希望より少なければ、合わないと判定する"
echo "scale の試験: $N 件とも通った"
