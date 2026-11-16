#!/usr/bin/env bash
# CloudFormation のテンプレートに、ASCII 以外の文字がないかを確かめる。
# CloudFormation は、受け取ったテンプレートの ASCII 以外の文字を「?」に置き換える（docs/findings.md）。
# 日本語は、行の先頭が # のコメントにだけ書いてよい。コメントは AWS の上では化けるが、正本はリポジトリにある。
set -euo pipefail
cd "$(dirname "$0")/.."
if grep -n -P '[^\x00-\x7F]' aws/*.yaml | grep -v -P '^[^:]+:\d+:\s*#'; then
  echo "上の行に ASCII 以外の文字がある。Description、Metadata、値は英語で書き、日本語は # のコメントに移す" >&2
  exit 1
fi
