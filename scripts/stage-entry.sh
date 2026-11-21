#!/usr/bin/env bash
# 入口の中継（Web Functions）の zip を local/run/entry.zip に作り、そのパスを出す。依存のパッケージは使わない。
# zip の直下に index.js（services/entry/index.js）を置き、TypeScript は JavaScript に変えて入れる。
# 中身が同じなら同じ zip になるように、時刻をそろえ、並びを固定する（S3 のキーを中身のハッシュにするため）。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=local/run/entry
rm -rf "$OUT" "$OUT.zip" && mkdir -p "$OUT/services/entry"
printf '{ "type": "module" }\n' > "$OUT/package.json"
# Lambda の実行環境で型の取り除きが動くかに頼らないよう、ここで JavaScript に変える（Node.js 24 の module.stripTypeScriptTypes）。
# 読み込みの指定（"./proxy.ts"）も .js に替える。入口の index.js は main.js を読む
mkdir -p "$OUT/services/entry/src"
node --no-warnings -e '
const { stripTypeScriptTypes } = require("node:module");
const fs = require("node:fs");
const [src, dst] = process.argv.slice(1);
for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".ts"))) {
  const js = stripTypeScriptTypes(fs.readFileSync(`${src}/${f}`, "utf8")).replace(/(from\s+"\.[^"]*)\.ts"/g, "$1.js\"");
  fs.writeFileSync(`${dst}/${f.replace(/\.ts$/, ".js")}`, js);
}' services/entry/src "$OUT/services/entry/src"
sed 's#/main\.ts"#/main.js"#' services/entry/index.js > "$OUT/index.js"
# zip のコマンドがない環境があるので、Python の zipfile で作る
python3 -I - "$OUT" "$OUT.zip" <<'PY'
import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
files = sorted(os.path.relpath(os.path.join(d, f), src) for d, _, fs in os.walk(src) for f in fs)
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        info = zipfile.ZipInfo(f, date_time=(2000, 1, 1, 0, 0, 0))
        info.external_attr = 0o644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        with open(os.path.join(src, f), "rb") as h:
            z.writestr(info, h.read())
PY
echo "$(pwd)/$OUT.zip"
