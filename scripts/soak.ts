// シナリオ 2: SVID を短い有効期限で入れ替えながら、連鎖を続けて呼び、失敗を数える。
// 使い方: node scripts/soak.ts [--target local | --target aws --as bff] [--minutes 30] [--interval 1000]
import { readFileSync, writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { join } from "node:path";
import { targetFrom, type Service } from "./target.ts";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const minutes = arg("minutes", 30);
const interval = arg("interval", 1000);
const t = targetFrom(process.argv);
// 入れ替えを数えるのは、鍵を持つ役の SVID だけ（ローカルは 3 つ、AWS は --as の 1 つ）。
// AWS の 3 つのサービスの回数は、aws/run-scenarios.sh がアプリのログ（svid_rotated）から数える
const SERVICES = t.roles;
// 利用者のアクセストークンの有効期限（Cognito では 5 分）より前に取り直す
const TOKEN_REFRESH_MS = 4 * 60_000;

const serial = (s: Service) => new X509Certificate(readFileSync(join(t.svidDir(s), "svid.pem"))).serialNumber;

const seen: Record<string, string[]> = Object.fromEntries(SERVICES.map((s) => [s, [serial(s)]]));
const failures: { at: string; status: number; body: string }[] = [];
let ok = 0;
let token = await t.userToken();
let tokenAt = Date.now();
const end = Date.now() + minutes * 60_000;
const started = new Date().toISOString();

while (Date.now() < end) {
  if (Date.now() - tokenAt > TOKEN_REFRESH_MS) [token, tokenAt] = [await t.userToken(), Date.now()];
  for (const s of SERVICES) {
    try {
      const cur = serial(s);
      if (seen[s].at(-1) !== cur) {
        seen[s].push(cur);
        console.log(`${new Date().toISOString()} ${s} の SVID が入れ替わった（${seen[s].length - 1} 回目）`);
      }
    } catch {
      // 書き換えの途中に読むことがある。次の回で読む
    }
  }
  try {
    const r = await fetch(`${t.bffUrl}/transfer`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ amount: 1, to: "acct-2" }),
    });
    const body = await r.text();
    if (r.status === 200) ok++;
    else failures.push({ at: new Date().toISOString(), status: r.status, body });
  } catch (e) {
    failures.push({ at: new Date().toISOString(), status: 0, body: String(e) });
  }
  await new Promise((r) => setTimeout(r, interval));
}

const summary = {
  target: t.name,
  started,
  ended: new Date().toISOString(),
  minutes,
  ok,
  failed: failures.length,
  rotations: Object.fromEntries(SERVICES.map((s) => [s, seen[s].length - 1])),
  failures,
};
if (t.outDir) {
  const out = join(t.outDir, `soak-${t.name}-${started.replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`記録: ${out}`);
}
console.log(`RESULT ${JSON.stringify({ ...summary, failures: failures.slice(0, 20) })}`);
process.exit(failures.length === 0 ? 0 : 1);
