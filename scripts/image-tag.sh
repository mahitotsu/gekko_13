#!/usr/bin/env bash
# イメージのタグを、そのイメージの材料の、コミットした中身（git の tree のハッシュ）から作って出す。
# 材料が同じなら、コミットが変わっても同じタグになり、イメージを作り直さず、ECS のタスクも入れ替わらない。
# 材料に、コミットしていない変更か、追っていないファイルがあれば止める（AWS に送る前に、先にコミットする）。
# タグは c- と、「ビルドの引数」と「材料の各ファイルの blob のハッシュ」を並べた SHA-256 の先頭 12 字。
# 使い方: scripts/image-tag.sh <ビルドの引数の文字列> <pathspec>...
#   例: scripts/image-tag.sh "SPIRE=1.15.3" Dockerfile package.json packages services ':!services/auth'
set -euo pipefail
cd "$(dirname "$0")/.."
ARGS=${1?ビルドの引数の文字列を渡す（なければ空の文字列）}
shift
[ $# -gt 0 ] || { echo "pathspec を 1 つ以上渡す" >&2; exit 2; }
if ! git diff --quiet HEAD -- "$@" || [ -n "$(git ls-files --others --exclude-standard -- "$@")" ]; then
  echo "材料にコミットしていない変更がある。先にコミットする: $*" >&2
  git status --short -- "$@" >&2
  exit 1
fi
# ls-files -s の行は「モード blob のハッシュ ステージ<TAB>パス」。上で変更がないことを確かめたので、コミットした中身と同じになる。
# ls-tree は除外の指定（:!）を受け付けないので、ls-files を使う
TREE=$(git ls-files -s -- "$@")
[ -n "$TREE" ] || { echo "材料のファイルが 1 つもない: $*" >&2; exit 1; }
SUM=$({ printf 'args %s\n' "$ARGS"; printf '%s\n' "$TREE"; } | sha256sum | cut -c1-12)
echo "c-$SUM"
