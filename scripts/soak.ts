// シナリオ 2: SVID を短い有効期限で入れ替えながら、連鎖を続けて呼び、失敗を数える。
// 使い方: node scripts/soak.ts [分（既定 30）] [間隔のミリ秒（既定 1000）]
import { readFileSync, writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { join } from "node:path";

const minutes = Number(process.argv[2] ?? 30);
const interval = Number(process.argv[3] ?? 1000);
const ROOT = new URL("../local/run/", import.meta.url).pathname;
const BFF = "http://127.0.0.1:18080";
const ISSUER = "http://127.0.0.1:19000";
const SERVICES = ["bff", "transfer", "ledger"];

const serial = (s: string) => new X509Certificate(readFileSync(join(ROOT, "svid", s, "svid.pem"))).serialNumber;

async function userToken() {
  const r = await fetch(`${ISSUER}/test/login`, { method: "POST", body: JSON.stringify({ sub: "demo-user", scope: "banking/view banking/transfer" }) });
  return ((await r.json()) as { access_token: string }).access_token;
}

const seen: Record<string, string[]> = Object.fromEntries(SERVICES.map((s) => [s, [serial(s)]]));
const failures: { at: string; status: number; body: string }[] = [];
let ok = 0;
let token = await userToken();
let tokenAt = Date.now();
const end = Date.now() + minutes * 60_000;
const started = new Date().toISOString();

while (Date.now() < end) {
  if (Date.now() - tokenAt > 30 * 60_000) [token, tokenAt] = [await userToken(), Date.now()];
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
    const r = await fetch(`${BFF}/transfer`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ amount: 1, to: "acct-2" }) });
    const body = await r.text();
    if (r.status === 200) ok++;
    else failures.push({ at: new Date().toISOString(), status: r.status, body });
  } catch (e) {
    failures.push({ at: new Date().toISOString(), status: 0, body: String(e) });
  }
  await new Promise((r) => setTimeout(r, interval));
}

const summary = {
  started,
  ended: new Date().toISOString(),
  minutes,
  ok,
  failed: failures.length,
  rotations: Object.fromEntries(SERVICES.map((s) => [s, seen[s].length - 1])),
  failures,
};
const out = join(ROOT, `soak-${started.replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, failures: failures.slice(0, 5) }, null, 2));
console.log(`記録: ${out}`);
process.exit(failures.length === 0 ? 0 : 1);
