// 合格の基準（docs/plan.md の 3 節）のシナリオを回す。
// 使い方:
//   ローカル: node scripts/scenarios.ts --target local              （local/up.sh の環境に、ホストから当てる。全部を回す）
//   AWS:      node scripts/scenarios.ts --target aws --as <役>      （aws/run-scenarios.sh が、ECS のサービス probe-<役> として動かす）
// 「盗まれた鍵」は、そのサービスが乗っ取られた想定で、そのサービスの SVID を使う。
// ローカルはホストのパスから 3 つとも読む。AWS は、役のファミリーのタスクとして動き、自分の SVID だけを持つ。
// そのため AWS では、役が鍵を持つシナリオだけを回し、aws/run-scenarios.sh が 3 つの役と rogue の結果をまとめる（scripts/aws-collect.ts）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { mtlsCall, spiffeIdOf, type Svid } from "../packages/spiffe-tls/src/index.ts";
import { targetFrom, type Service, type Target } from "./target.ts";

const TD = "gekko13.internal";
const id = (s: string) => `spiffe://${TD}/svc/${s}`;

type Result = { id: string; title: string; expected: string; actual: string; pass: boolean | "skipped" };
const results: Result[] = [];
const record = (r: Result) => {
  results.push(r);
  const mark = r.pass === "skipped" ? "SKIP" : r.pass ? "PASS" : "FAIL";
  console.log(`${mark} ${r.id} ${r.title}\n     期待: ${r.expected}\n     実際: ${r.actual}`);
};

const has = (t: Target, s: Service) => t.roles.includes(s);

const svidOf = (t: Target, s: Service): Svid => {
  const dir = t.svidDir(s);
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

const describeError = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  return `接続の失敗 ${err.code ?? ""} ${err.message ?? String(e)}`.trim();
};

async function tryCall(t: Target, svid: Pick<Svid, "cert" | "key" | "bundle">, expectId: string, token?: string) {
  try {
    const r = await mtlsCall(svid, `${t.ledgerUrl}/entries`, expectId, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ amount: 1, to: "acct-x" }),
    });
    return { status: r.status, text: `${r.status} ${r.body}` };
  } catch (e) {
    return { status: 0, text: describeError(e) };
  }
}

/** ローカル: ラベルを付けた spiffe-helper を docker で動かし、SVID が出るかを見る。 */
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

/** 偽の証明書。AWS ではイメージに入れたものを、ローカルではその場で作ったものを使う。 */
function fakeCerts(t: Target): { dir: string; cleanup: () => void } {
  if (t.fakeCertDir) return { dir: t.fakeCertDir, cleanup: () => {} };
  const dir = mkdtempSync(join(tmpdir(), "gekko13-fake-"));
  execFileSync(new URL("./make-fake-certs.sh", import.meta.url).pathname, [dir]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function identityScenarios(t: Target) {
  // AWS では、役が 1 つなので、自分の ID だけを記録する。3 つの役がそろって 1-a になる（scripts/aws-collect.ts）
  const names = t.roles;
  const ids = names.map((s) => svidOf(t, s).id);
  record({
    id: "1-a",
    title: t.name === "local" ? "登録したファミリーごとに、別の SPIFFE ID が配られる" : `登録したファミリーの SPIFFE ID が配られる（${names.join(", ")}）`,
    expected: names.map(id).join(", "),
    actual: ids.join(", "),
    pass: ids.join() === names.map(id).join(),
  });

  // AWS の 1-b は、rogue のタスクが自分で確かめて出す。1-c は AWS では行わない（ホストのシェルが要る）
  if (t.name === "local") {
    const rogue = await helperWithLabels("gekko13-rogue", 20_000);
    record({ id: "1-b", title: "登録していないファミリーのタスク", expected: "20 秒待っても SVID が出ない", actual: rogue ?? "SVID なし", pass: rogue === undefined });
    const forged = await helperWithLabels("gekko13-ledger", 20_000);
    record({
      id: "1-c",
      title: "ホストで docker run にラベルを偽って付けたコンテナ",
      expected: `SVID が出る（残るリスクとして記録）: ${id("ledger")}`,
      actual: forged ?? "SVID なし",
      pass: forged === id("ledger"),
    });
  }
}

/**
 * 役ごとに受け持つ。bff は 3-a と 3-d、transfer は 3-b、3-c、3-e、3-e2、3-f、3-g と CLAIMS。ledger は受け持たない。
 * ローカルは役が 3 つともあるので、今までどおり全部を回す。
 */
async function tokenScenarios(t: Target) {
  if (!has(t, "bff") && !has(t, "transfer")) return;
  const user = await t.userToken();
  const bffToken = await t.bffDelegatedToken(user);

  if (has(t, "bff")) {
    const a = await fetch(`${t.bffUrl}/transfer`, {
      method: "POST",
      headers: { authorization: `Bearer ${user}`, "content-type": "application/json" },
      body: JSON.stringify({ amount: 1000, to: "acct-2" }),
    }).then(async (r) => ({ status: r.status, body: await r.text() }));
    record({ id: "3-a", title: "正しい証明書と正しいトークン（BFF → transfer → ledger）", expected: "200", actual: `${a.status} ${a.body}`, pass: a.status === 200 });
  }

  if (!has(t, "transfer")) {
    if (has(t, "bff")) await bffKeyScenarios(t, bffToken);
    return;
  }

  // 信頼するバンドルは、同じ信頼ドメインのものなら、どの SVID に付いてきたものでもよい
  const ledgerBundle = svidOf(t, has(t, "ledger") ? "ledger" : "transfer").bundle;
  const b = await tryCall(t, { cert: "", key: "", bundle: ledgerBundle }, id("ledger"), user);
  record({ id: "3-b", title: "証明書なしで ledger を呼ぶ", expected: "TLS で拒否", actual: b.text, pass: b.status === 0 });

  const c = await tryCall(t, svidOf(t, "transfer"), id("ledger"), bffToken);
  record({
    id: "3-c",
    title: "transfer の鍵で、BFF が交換したトークン（act.client_id が BFF）を ledger に送る",
    expected: "403 peer_actor_mismatch",
    actual: c.text,
    pass: c.status === 403 && c.text.includes("peer_actor_mismatch"),
  });

  if (has(t, "bff")) await bffKeyScenarios(t, bffToken);

  const fake = fakeCerts(t);
  try {
    for (const [rid, sub, title] of [
      ["3-e", "other-td", "別の信頼ドメインの証明書"],
      ["3-e2", "same-id", "同じ SPIFFE ID を名乗る、別の認証局の証明書"],
    ] as const) {
      const cert = readFileSync(join(fake.dir, sub, "cert.pem"), "utf8");
      const key = readFileSync(join(fake.dir, sub, "key.pem"), "utf8");
      const e = await tryCall(t, { cert, key, bundle: ledgerBundle }, id("ledger"), bffToken);
      record({ id: rid, title, expected: "TLS で拒否", actual: e.text, pass: e.status === 0 });
    }
  } finally {
    fake.cleanup();
  }

  const f = await tryCall(t, svidOf(t, "transfer"), id("ledger"));
  record({ id: "3-f", title: "transfer の鍵で、トークンなし", expected: "401 no_token", actual: f.text, pass: f.status === 401 });
  const g = await tryCall(t, svidOf(t, "transfer"), id("transfer"), bffToken);
  record({ id: "3-g", title: "呼ぶ側が、相手を transfer だと思って ledger につなぐ", expected: "呼ぶ側が接続を止める", actual: g.text, pass: g.status === 0 && g.text.includes("SPIFFE ID") });

  // 本物の Cognito のトークンの形を残す（署名と秘密は残さない。ドキュメントと実測の食い違いを確かめるため）
  const claims = (tok: string) => JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString("utf8"));
  const shape = (c: Record<string, unknown>) => ({
    ...c,
    sub: "(省略)",
    username: c.username ? "(省略)" : undefined,
    jti: "(省略)",
    origin_jti: c.origin_jti ? "(省略)" : undefined,
    event_id: undefined,
  });
  console.log(`CLAIMS user ${JSON.stringify(shape(claims(user)))}`);
  console.log(`CLAIMS bff-delegated ${JSON.stringify(shape(claims(bffToken)))}`);
}

/** 3-d: 乗っ取られた BFF が、transfer を飛ばして ledger を直接呼ぶ。 */
async function bffKeyScenarios(t: Target, bffToken: string) {
  const d = await tryCall(t, svidOf(t, "bff"), id("ledger"), bffToken);
  record({
    id: "3-d",
    title: "BFF の鍵で ledger を直接呼ぶ（transfer を飛ばす）",
    expected: "403 caller_not_allowed",
    actual: d.text,
    pass: d.status === 403 && d.text.includes("caller_not_allowed"),
  });
}

async function main() {
  const t = targetFrom(process.argv);
  await identityScenarios(t);
  await tokenScenarios(t);

  const graded = results.filter((r) => r.pass !== "skipped");
  const failed = graded.filter((r) => !r.pass);
  const summary = { at: new Date().toISOString(), target: t.name, roles: t.roles, results };
  if (t.outDir) {
    const out = join(t.outDir, `scenarios-${t.name}-${summary.at.replace(/[:.]/g, "-")}.json`);
    writeFileSync(out, JSON.stringify(summary, null, 2));
    console.log(`記録: ${out}`);
  }
  // AWS では、ログから結果を拾う（aws/run-scenarios.sh）
  console.log(`RESULT ${JSON.stringify(summary)}`);
  console.log(`\n${graded.length - failed.length}/${graded.length} 件が期待どおり（対象外 ${results.length - graded.length} 件）。`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
