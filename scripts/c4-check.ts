// 段 C の C-4 の判定（docs/plan.md の 3 節）。local/up.sh の認可サーバー（services/auth）に、ホストから当てる。
// 使い方: SVID_TTL=120 local/up.sh のあとで、node scripts/c4-check.ts
// bff と transfer の SVID は、local/up.sh がホストの利用者の権限で local/run/svid/ に書いたものを読む（盗まれた鍵の想定にも使う）。
// C4-7 は、bff と auth の SVID が入れ替わるのを待つ（SVID_TTL=120 なら約 1 分。最大 5 分）。
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { mtlsCall, spiffeIdOf, type Svid } from "../packages/spiffe-tls/src/index.ts";

const TD = "gekko13.internal";
const AUTH_ID = `spiffe://${TD}/svc/auth`;
const HOST = "127.0.0.1";
const PORT = 19443;
const URL_TOKEN = `https://${HOST}:${PORT}/oauth2/token`;
const RUN = new URL("../local/run/", import.meta.url).pathname;
const ACCESS = "urn:ietf:params:oauth:token-type:access_token";

type Result = { id: string; title: string; expected: string; actual: string; pass: boolean };
const results: Result[] = [];
const record = (r: Result) => {
  results.push(r);
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id} ${r.title}\n     期待: ${r.expected}\n     実際: ${r.actual}`);
};

const svidOf = (name: string): Svid => {
  const dir = join(RUN, "svid", name);
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

/** RFC 8705 の x5t#S256。葉の証明書の DER の SHA-256 を、詰め物なしの base64url で書く。 */
const thumbprint = (pem: string) => createHash("sha256").update(new X509Certificate(pem).raw).digest("base64url");

const claimsOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** トークンの窓口を呼ぶ。TLS の握手で拒まれたら、status 0 と理由を返す。 */
async function token(svid: Pick<Svid, "cert" | "key" | "bundle">, body: Record<string, string>, headers = {}) {
  try {
    const r = await mtlsCall(svid, URL_TOKEN, AUTH_ID, { method: "POST", headers: { ...FORM, ...headers }, body: form(body) });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(r.body || "{}");
    } catch {
      json = { raw: r.body };
    }
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, json: { tls_error: String(e) } };
  }
}

const summary = (r: { status: number; json: Record<string, unknown> }) =>
  r.status === 200 ? "200（トークンが出た）" : `${r.status} ${JSON.stringify(r.json)}`;

/** 認可サーバーが、いま示している証明書のシリアル。 */
function serverSerial(bundle: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: HOST, port: PORT, ca: bundle, checkServerIdentity: () => undefined }, () => {
      const serial = s.getPeerCertificate().serialNumber;
      s.end();
      resolve(serial);
    });
    s.on("error", reject);
  });
}

const clientCredentials = (svid: Svid, clientId: string) =>
  token(svid, { grant_type: "client_credentials", client_id: clientId });

async function standinToken(bundle: string): Promise<string> {
  const env = readFileSync(join(RUN, "auth.env"), "utf8");
  const secret = /^STANDIN_SECRET=(.+)$/m.exec(env)?.[1]?.trim() ?? "";
  const basic = Buffer.from(`user-standin:${secret}`).toString("base64");
  const r = await token({ cert: "", key: "", bundle }, { grant_type: "client_credentials" }, { authorization: `Basic ${basic}` });
  if (r.status !== 200) throw new Error(`利用者の代わりのトークンを得られない: ${summary(r)}`);
  return String(r.json.access_token);
}

const exchange = (svid: Svid, clientId: string, subject: string, actor: string) =>
  token(svid, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: clientId,
    subject_token: subject,
    subject_token_type: ACCESS,
    actor_token: actor,
    actor_token_type: ACCESS,
    audience: "transfer-client",
  });

async function main() {
  const bff = svidOf("bff");
  const transfer = svidOf("transfer");

  // C4-1: 証明書を示さない
  const r1 = await token({ cert: "", key: "", bundle: bff.bundle }, { grant_type: "client_credentials", client_id: "bff-client" });
  record({ id: "C4-1", title: "証明書を示さずに bff-client を名乗る", expected: "401 invalid_client", actual: summary(r1), pass: r1.status === 401 });

  // C4-2: bff の SVID で client_credentials
  const r2 = await clientCredentials(bff, "bff-client");
  const actor = String(r2.json.access_token ?? "");
  const c2 = r2.status === 200 ? claimsOf(actor) : {};
  const x5t2 = (c2.cnf as Record<string, string> | undefined)?.["x5t#S256"];
  record({
    id: "C4-2",
    title: "bff の SVID で client_credentials",
    expected: "200、cnf.x5t#S256 が bff の SVID の拇印と一致",
    actual: `${summary(r2)}、cnf の一致: ${x5t2 === thumbprint(bff.cert)}`,
    pass: r2.status === 200 && x5t2 === thumbprint(bff.cert),
  });

  // C4-3: transfer の SVID で bff-client を名乗る
  const r3 = await clientCredentials(transfer, "bff-client");
  record({ id: "C4-3", title: "transfer の SVID で bff-client を名乗る", expected: "401 invalid_client", actual: summary(r3), pass: r3.status === 401 });

  // C4-4: SPIRE ではない CA の証明書（同じ SPIFFE ID を名乗る）
  const fake = mkdtempSync(join(tmpdir(), "gekko13-c4-"));
  try {
    execFileSync(new URL("./make-fake-certs.sh", import.meta.url).pathname, [fake]);
    const dir = join(fake, "same-id");
    const forged = { cert: readFileSync(join(dir, "cert.pem"), "utf8"), key: readFileSync(join(dir, "key.pem"), "utf8"), bundle: bff.bundle };
    const r4 = await token(forged, { grant_type: "client_credentials", client_id: "transfer-client" });
    record({ id: "C4-4", title: "SPIRE 以外の CA の証明書で transfer を名乗る", expected: "TLS の握手で拒まれる", actual: summary(r4), pass: r4.status === 0 });
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }

  // C4-5: bff が、利用者の代わりのトークン（may_act が bff）を、自分のトークンを actor にして交換する
  const subject = await standinToken(bff.bundle);
  const r5 = await exchange(bff, "bff-client", subject, actor);
  const c5 = r5.status === 200 ? claimsOf(String(r5.json.access_token)) : {};
  const act5 = c5.act as Record<string, unknown> | undefined;
  const x5t5 = (c5.cnf as Record<string, string> | undefined)?.["x5t#S256"];
  record({
    id: "C4-5",
    title: "bff の SVID で交換する（subject は may_act が bff、actor は C4-2 のトークン）",
    expected: "200、act.sub が bff-client、cnf が bff の拇印",
    actual: `${summary(r5)}、sub: ${String(c5.sub)}、act: ${JSON.stringify(act5)}、aud: ${JSON.stringify(c5.aud)}、cnf の一致: ${x5t5 === thumbprint(bff.cert)}`,
    pass: r5.status === 200 && act5?.sub === "bff-client" && x5t5 === thumbprint(bff.cert),
  });

  // C4-6: transfer が自分の SVID で正しく認証し、盗んだ bff のトークンで交換を求める
  const r6 = await exchange(transfer, "transfer-client", subject, actor);
  record({ id: "C4-6", title: "transfer が、盗んだ bff のトークンで交換を求める", expected: "400 invalid_grant", actual: summary(r6), pass: r6.status === 400 });

  // C4-7: SVID のローテーション
  const auth0 = svidOf("auth").serial;
  const served0 = await serverSerial(bff.bundle);
  const bff0 = bff.serial;
  console.log(`     C4-7 を待つ: auth のファイル ${auth0}、示している ${served0}、bff ${bff0}`);
  const deadline = Date.now() + 5 * 60_000;
  let now = { auth: auth0, bff: bff0 };
  while (Date.now() < deadline && (now.auth === auth0 || now.bff === bff0)) {
    await new Promise((r) => setTimeout(r, 5000));
    now = { auth: svidOf("auth").serial, bff: svidOf("bff").serial };
  }
  // reload-on-update は、ファイルの変化から quiet-period（1 秒）待ってから読み直す。少し余らせて待つ
  await new Promise((r) => setTimeout(r, 5000));
  const served1 = await serverSerial(bff.bundle);
  const bff1 = svidOf("bff");
  const r7 = await clientCredentials(bff1, "bff-client");
  const x5t7 = r7.status === 200 ? (claimsOf(String(r7.json.access_token)).cnf as Record<string, string> | undefined)?.["x5t#S256"] : undefined;
  const r7old = await exchange(bff1, "bff-client", subject, actor);
  const rotated = now.auth !== auth0 && now.bff !== bff0;
  record({
    id: "C4-7",
    title: "SVID が入れ替わったあと",
    expected: "認可サーバーが再起動なしで新しい証明書を示し、新しい SVID の cnf が新しい拇印になる",
    actual:
      `入れ替わり: ${rotated}、示す証明書が新しいファイルと一致: ${served1 === now.auth}（前 ${served0}）、` +
      `新しい cnf の一致: ${x5t7 === thumbprint(bff1.cert)}。参考: 入れ替わる前の actor_token での交換は ${summary(r7old)}`,
    pass: rotated && served1 === now.auth && served1 !== served0 && x5t7 === thumbprint(bff1.cert),
  });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 合格`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
