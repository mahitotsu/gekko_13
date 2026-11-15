// 合格の基準（計画の表）のシナリオを回す。ローカルでは local/up.sh の環境に、ホストから当てる。
// 使い方: node scripts/scenarios.ts [--target local]
// 「盗まれた鍵」は、local/run/svid/<svc>/ の SVID を読んで使う（そのサービスが乗っ取られた想定）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mtlsCall, spiffeIdOf, type Svid } from "../packages/spiffe-tls/src/index.ts";
import { X509Certificate } from "node:crypto";

const TD = "gekko13.internal";
const id = (s: string) => `spiffe://${TD}/svc/${s}`;
const ROOT = new URL("../local/run/", import.meta.url).pathname;
const BFF = "http://127.0.0.1:18080";
const LEDGER = "https://127.0.0.1:28443";
const ISSUER = "http://127.0.0.1:19000";

type Result = { id: string; title: string; expected: string; actual: string; pass: boolean };
const results: Result[] = [];
const record = (r: Result) => {
  results.push(r);
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id} ${r.title}\n     期待: ${r.expected}\n     実際: ${r.actual}`);
};

const svidOf = (s: string): Svid => {
  const dir = join(ROOT, "svid", s);
  const cert = readFileSync(join(dir, "svid.pem"), "utf8");
  const leaf = new X509Certificate(cert);
  return {
    cert,
    key: readFileSync(join(dir, "svid_key.pem"), "utf8"),
    bundle: readFileSync(join(dir, "svid_bundle.pem"), "utf8"),
    id: spiffeIdOf(leaf.subjectAltName) ?? "",
    notAfter: leaf.validTo,
    serial: leaf.serialNumber,
  };
};

const envFile = (name: string) =>
  Object.fromEntries(
    readFileSync(join(ROOT, name), "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.text() };
}

async function userToken() {
  const r = await post(`${ISSUER}/test/login`, { sub: "demo-user", scope: "banking/view banking/transfer" });
  return (JSON.parse(r.body) as { access_token: string }).access_token;
}

/** BFF として交換したトークン（act.client_id = bff-client）。BFF が transfer に送るものと同じ形。 */
async function bffDelegatedToken(user: string) {
  const { CLIENT_ID, CLIENT_SECRET } = envFile("bff.env");
  const auth = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
  const form = (p: Record<string, string>) =>
    fetch(`${ISSUER}/oauth2/token`, { method: "POST", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(p) }).then(
      (r) => r.json() as Promise<{ access_token: string }>,
    );
  const actor = await form({ grant_type: "client_credentials", scope: "internal/actor" });
  const t = await form({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: user,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    actor_token: actor.access_token,
    actor_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: "banking/transfer",
  });
  return t.access_token;
}

const describeError = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  return `接続の失敗 ${err.code ?? ""} ${err.message ?? String(e)}`.trim();
};

async function tryCall(svid: Pick<Svid, "cert" | "key" | "bundle">, expectId: string, token?: string) {
  try {
    const r = await mtlsCall(svid, `${LEDGER}/entries`, expectId, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ amount: 1, to: "acct-x" }),
    });
    return { status: r.status, text: `${r.status} ${r.body}` };
  } catch (e) {
    return { status: 0, text: describeError(e) };
  }
}

/** 別の認証局で、SPIFFE の形の証明書を作る。 */
function fakeSvid(dir: string, spiffeId: string) {
  const o = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "ext.cnf"), `subjectAltName=URI:${spiffeId}\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth,serverAuth\n`);
  o(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/O=fake"]);
  o(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/O=fake"]);
  o(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "ext.cnf"]);
  return { cert: readFileSync(join(dir, "leaf.pem"), "utf8"), key: readFileSync(join(dir, "leaf.key"), "utf8") };
}

/** ラベルを付けた spiffe-helper を動かし、SVID が出るかを見る。 */
async function helperWithLabels(family: string, waitMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "gekko13-helper-"));
  const name = `gekko13-probe-${family}-${Date.now()}`;
  const conf = new URL("../local/helper/helper.conf", import.meta.url).pathname;
  execFileSync("docker", [
    "run", "-d", "--name", name, "--label", "gekko13=1", "--network", "gekko13",
    "--user", `${process.getuid!()}:${process.getgid!()}`,
    "--label", `com.amazonaws.ecs.task-definition-family=${family}`,
    "--label", "com.amazonaws.ecs.container-name=svid-helper",
    "-v", "gekko13-agent-sockets:/run/spire/sockets:ro", "-v", `${conf}:/etc/helper/helper.conf:ro`, "-v", `${dir}:/svid`,
    "ghcr.io/spiffe/spiffe-helper:0.11.0", "-config", "/etc/helper/helper.conf",
  ]);
  const deadline = Date.now() + waitMs;
  let got: string | undefined;
  while (Date.now() < deadline) {
    if (existsSync(join(dir, "svid.pem"))) {
      got = spiffeIdOf(new X509Certificate(readFileSync(join(dir, "svid.pem"))).subjectAltName);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true });
  return got;
}

async function main() {
  // 1-a
  const ids = ["bff", "transfer", "ledger"].map((s) => svidOf(s).id);
  record({
    id: "1-a",
    title: "登録したファミリーごとに、別の SPIFFE ID が配られる",
    expected: ["bff", "transfer", "ledger"].map(id).join(", "),
    actual: ids.join(", "),
    pass: ids.join() === ["bff", "transfer", "ledger"].map(id).join(),
  });

  // 1-b
  const rogue = await helperWithLabels("gekko13-rogue", 20_000);
  record({ id: "1-b", title: "登録していないファミリーのタスク", expected: "20 秒待っても SVID が出ない", actual: rogue ?? "SVID なし", pass: rogue === undefined });

  // 1-c
  const forged = await helperWithLabels("gekko13-ledger", 20_000);
  record({
    id: "1-c",
    title: "ホストで docker run にラベルを偽って付けたコンテナ",
    expected: `SVID が出る（残るリスクとして記録）: ${id("ledger")}`,
    actual: forged ?? "SVID なし",
    pass: forged === id("ledger"),
  });

  const user = await userToken();

  // 3-a
  const a = await post(`${BFF}/transfer`, { amount: 1000, to: "acct-2" }, { authorization: `Bearer ${user}` });
  record({ id: "3-a", title: "正しい証明書と正しいトークン（BFF → transfer → ledger）", expected: "200", actual: `${a.status} ${a.body}`, pass: a.status === 200 });

  // 3-b
  const ledgerBundle = svidOf("ledger").bundle;
  const b = await tryCall({ cert: "", key: "", bundle: ledgerBundle }, id("ledger"), user);
  record({ id: "3-b", title: "証明書なしで ledger を呼ぶ", expected: "TLS で拒否", actual: b.text, pass: b.status === 0 });

  // 3-c
  const bffToken = await bffDelegatedToken(user);
  const c = await tryCall(svidOf("transfer"), id("ledger"), bffToken);
  record({
    id: "3-c",
    title: "transfer の証明書で、BFF が受けたトークン（act.client_id=bff）を ledger に送る",
    expected: "403 peer_actor_mismatch",
    actual: c.text,
    pass: c.status === 403 && c.text.includes("peer_actor_mismatch"),
  });

  // 3-d
  const d = await tryCall(svidOf("bff"), id("ledger"), bffToken);
  record({
    id: "3-d",
    title: "BFF の証明書で ledger を直接呼ぶ（transfer を飛ばす）",
    expected: "403 caller_not_allowed",
    actual: d.text,
    pass: d.status === 403 && d.text.includes("caller_not_allowed"),
  });

  // 3-e
  const tmp = mkdtempSync(join(tmpdir(), "gekko13-fake-"));
  try {
    const other = fakeSvid(tmp, "spiffe://evil.internal/svc/transfer");
    const e1 = await tryCall({ ...other, bundle: ledgerBundle }, id("ledger"), bffToken);
    record({ id: "3-e", title: "別の信頼ドメインの証明書", expected: "TLS で拒否", actual: e1.text, pass: e1.status === 0 });
    rmSync(tmp, { recursive: true, force: true });
    const tmp2 = mkdtempSync(join(tmpdir(), "gekko13-fake-"));
    const same = fakeSvid(tmp2, id("transfer"));
    const e2 = await tryCall({ ...same, bundle: ledgerBundle }, id("ledger"), bffToken);
    record({ id: "3-e2", title: "同じ SPIFFE ID を名乗る、別の認証局の証明書", expected: "TLS で拒否", actual: e2.text, pass: e2.status === 0 });
    rmSync(tmp2, { recursive: true, force: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // 追加: 正しい証明書でもトークンがなければ拒む。相手の SPIFFE ID が違えば、呼ぶ側が止める
  const f = await tryCall(svidOf("transfer"), id("ledger"));
  record({ id: "3-f", title: "transfer の正しい証明書で、トークンなし", expected: "401 no_token", actual: f.text, pass: f.status === 401 });
  const g = await tryCall(svidOf("transfer"), id("transfer"), bffToken);
  record({ id: "3-g", title: "呼ぶ側が、相手を transfer だと思って ledger につなぐ", expected: "呼ぶ側が接続を止める", actual: g.text, pass: g.status === 0 && g.text.includes("SPIFFE ID") });

  const failed = results.filter((r) => !r.pass);
  const out = join(ROOT, `scenarios-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} 件が期待どおり。記録: ${out}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
