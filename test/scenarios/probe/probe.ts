// 試験の補助は、相手の JSON を形を決めずに扱う（gekko_11 と同じ）
/* eslint-disable @typescript-eslint/no-explicit-any */
// 段 D の D1-b の確かめの役（gekko_11 の test/cluster/probe/probe.ts を写して直した）。顧客、乗っ取られた複製、攻撃者、運用の担当、監査の役を演じる。
// 通信だけを受け持つ。署名（passkey）と内容の組み立ては、試験の側（test/scenarios）が行う。
// 自分の SVID（svid-helper が /svid に書き出す）を使うか、証明書なしで呼ぶ。結果は JSON で標準出力に書く。
// 役の身元は、svid-helper が受け取る SVID で決まる（本物と同じ SPIFFE ID を持つ複製、登録のない攻撃者など）。
// gekko_11 との違い: 名前空間がない。呼び先はサービスの名前（手元は docker の別名、AWS は Service Connect）。ログインサーバーは、
// 入口のリバースプロキシの /login の下にある（ENTRY_URL で呼び、公開の名前は PUBLIC_ORIGIN）。防御を外す管理のポートはない。
// 使い方: node test/scenarios/probe/probe.ts <コマンド> '<JSON の引数>'。環境変数 SELF（自分のクライアント ID）、PUBLIC_ORIGIN、ENTRY_URL、RP_ID、DEMO_PASSWORD
import { createHash, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request } from "node:https";
import type { PeerCertificate } from "node:tls";
import { calculateJwkThumbprint, decodeJwt, exportJWK, importJWK, SignJWT, type JWK } from "jose";
import { newAuthenticator, register } from "./webauthn.ts";

const TRUST_DOMAIN = process.env.TRUST_DOMAIN ?? "gekko13.internal";
const SVID_DIR = process.env.SVID_DIR ?? "/svid";
const self = process.env.SELF!;
const spiffeId = (service: string) => `spiffe://${TRUST_DOMAIN}/svc/${service}`;
const PORTS: Record<string, number> = { auth: 8443, "sales-agent": 8443, "insurer-mcp": 9443, "insurer-backend": 9443 };
const origin = (service: string) => `https://${service}:${PORTS[service]}`;
/** ブラウザが入口を通って呼ぶ公開の origin。顧客の役は、署名と proof に、この名前を使う。 */
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN!;
/** 入口のリバースプロキシを呼ぶ先。手元では docker の名前、AWS では PUBLIC_ORIGIN と同じ */
const ENTRY_URL = process.env.ENTRY_URL ?? PUBLIC_ORIGIN;
const CUSTOMER_ORIGIN = PUBLIC_ORIGIN;
/** passkey の RP ID（入口の名前）。ログインと申込みの署名で同じ passkey を使う（gekko_11 の D-42）。 */
const RP_ID = process.env.RP_ID!;
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo";
const REDIRECT = `${CUSTOMER_ORIGIN}/callback`;
const ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token";
const FORM = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" };
/** 顧客のアプリ（BFF）のクライアント認証。spiffe-helper が書き出した JWT-SVID を示す（D-38、D-41）。 */
const clientAssertion = () => ({
  client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-spiffe",
  client_assertion: readFileSync(`${SVID_DIR}/jwt_svid.token`, "utf8").trim(),
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** 入口のリバースプロキシを通して、ログインサーバーや顧客のアプリを呼ぶ（ブラウザと同じ道）。 */
function viaEntry(path: string, init: { method: string; headers?: Record<string, string>; body?: string; clientCert?: boolean }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, ENTRY_URL);
    const req = (url.protocol === "https:" ? request : httpRequest)(url, { method: init.method, headers: init.headers, timeout: 120_000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(init.body);
  });
}

/** 相手の SPIFFE ID を確かめて呼ぶ。clientCert が真なら、自分の SVID を示す。 */
function call(
  service: string,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string; clientCert: boolean },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, origin(service)),
      {
        method: init.method,
        headers: init.headers,
        ca: readFileSync(`${SVID_DIR}/svid_bundle.pem`),
        ...(init.clientCert ? { cert: readFileSync(`${SVID_DIR}/svid.pem`), key: readFileSync(`${SVID_DIR}/svid_key.pem`) } : {}),
        checkServerIdentity: (_host: string, cert: PeerCertificate) =>
          cert.subjectaltname === `URI:${spiffeId(service)}` ? undefined : new Error(`相手の SPIFFE ID が違う: ${cert.subjectaltname}`),
        timeout: 120_000,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(init.body);
  });
}

const form = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();

function reply(r: Reply) {
  let body: unknown = r.body;
  try {
    body = JSON.parse(r.body);
  } catch {
    // JSON でない応答は、そのまま返す
  }
  return { status: r.status, body };
}

type SigningKey = Parameters<SignJWT["sign"]>[0];

async function dpopProof(key: SigningKey, jwk: JWK, htm: string, htu: string, token?: string): Promise<string> {
  return new SignJWT({ htm, htu, jti: randomUUID(), ...(token ? { ath: createHash("sha256").update(token).digest("base64url") } : {}) })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
    .setIssuedAt()
    .sign(key);
}

/** 応答の Cookie を、持っている Cookie に重ねる。 */
const cookiesOf = (r: Reply, held = "") => {
  const jar = new Map(held.split("; ").filter(Boolean).map((c) => [c.split("=")[0]!, c]));
  for (const c of r.headers["set-cookie"] ?? []) jar.set(c.split("=")[0]!, c.split(";")[0]!);
  return [...jar.values()].join("; ");
};
const pathOf = (location: unknown) => {
  const u = new URL(String(location));
  return u.pathname + u.search;
};

/**
 * 顧客のアプリの BFF の役（D-41）。顧客のアプリと同じ身元で動き、JWT-SVID でクライアント認証する。
 * 顧客の役: 固定ユーザーで、ログインサーバーにログインし、取決めの範囲に同意して、認可コードと PKCE と DPoP で A を受け取る。
 * 続けて、ログインしたまま P を受け取り、認可サーバーに受信箱の番号を登録する（D-26、D-42）。passkey は、ログインサーバーに登録する。
 * 返す authenticator と dpopKey は、手元のテストが署名と proof に使う。
 */
async function customerSetup(args: { user?: string; terms?: unknown }) {
  const html = { accept: "text/html" };
  const oidc = "/login/realms/insurer/protocol/openid-connect";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = await exportJWK(publicKey);
  let cookie: string;

  // ログインサーバーは、DPoP の htu を、入口が付ける公開の名前と照らす（入口は閲覧者の転送のヘッダーを捨てて、自分で付ける）
  const login = {};

  /** 認可コードを、DPoP に結んだトークンに替える。 */
  const redeem = async (location: unknown, verifier: string) => {
    const code = new URL(String(location)).searchParams.get("code");
    if (!code) throw new Error(`認可コードを受け取れない: ${String(location)}`);
    const path = `${oidc}/token`;
    return viaEntry(path, {
      method: "POST",
      headers: { ...FORM, ...login, dpop: await dpopProof(privateKey, jwk, "POST", `${PUBLIC_ORIGIN}${path}`) },
      body: form({ grant_type: "authorization_code", client_id: "customer-app", code, redirect_uri: REDIRECT, code_verifier: verifier, ...clientAssertion() }),
    });
  };
  const authorize = (scope: string, verifier: string, extra: Record<string, string | undefined>) =>
    `${oidc}/auth?${form({
      response_type: "code",
      client_id: "customer-app",
      scope,
      redirect_uri: REDIRECT,
      state: "s",
      nonce: "n",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      ...extra,
    })}`;

  // A を受け取る
  const verifier = randomUUID() + randomUUID();
  // 新しい端末として、ログインサーバーの画面で passkey を登録してもらう（Keycloak の AIA。D-42）
  const first = await viaEntry(authorize("openid apply", verifier, { authorization_details: args.terms ? JSON.stringify(args.terms) : undefined, kc_action: "webauthn-register-passwordless" }), { method: "GET", headers: { ...html, ...login }, clientCert: false });
  cookie = cookiesOf(first);
  const action = first.body.match(/action="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  if (!action) throw new Error(`ログインの画面を受け取れない: ${first.status} ${String(first.headers.location)}`);
  const posted = await viaEntry(pathOf(action), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...login, cookie },
    body: form({ username: args.user ?? "alice", password: PASSWORD }),
  });
  cookie = cookiesOf(posted, cookie);
  // パスワードの後に、ログインサーバーが passkey の登録の画面を出す。ブラウザの代わりに、ソフトウェアの認証器で登録してフォームを送る
  const authenticator = newAuthenticator();
  const page = posted.status === 200 ? posted : await viaEntry(pathOf(posted.headers.location), { method: "GET", headers: { ...html, ...login, cookie } });
  cookie = cookiesOf(page, cookie);
  const challenge = page.body.match(/challenge\s*:\s*['"]([^'"]+)['"]/)?.[1];
  const registerAction = page.body.match(/<form[^>]*id="register"[^>]*action="([^"]+)"|<form[^>]*action="([^"]+)"[^>]*id="register"/);
  if (!challenge || !registerAction) throw new Error(`passkey の登録の画面を受け取れない: ${page.status} ${String(page.headers.location)}`);
  const credential = register(authenticator, RP_ID, challenge, PUBLIC_ORIGIN);
  const registered = await viaEntry(pathOf((registerAction[1] ?? registerAction[2])!.replaceAll("&amp;", "&")), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...login, cookie },
    body: form({ clientDataJSON: credential.response.clientDataJSON, attestationObject: credential.response.attestationObject, publicKeyCredentialId: credential.id, authenticatorLabel: `probe-${randomUUID().slice(0, 8)}`, transports: "internal", authenticatorAttachment: "platform" }),
  });
  cookie = cookiesOf(registered, cookie);
  // ログインサーバーは、同じ利用者の中で、同じ名前の passkey を断り、登録の画面を出し直す（302 で戻らない）
  if (registered.status !== 302) throw new Error(`passkey を登録できない: ${registered.status}`);
  const res = await redeem(registered.headers.location, verifier);
  const body = JSON.parse(res.body) as { access_token?: string; id_token?: string; refresh_token?: string };

  // 受信箱の登録に使う P を受け取る（ログインしたまま）
  const verifierP = randomUUID() + randomUUID();
  const silent = await viaEntry(authorize("openid passkeys", verifierP, { prompt: "none" }), { method: "GET", headers: { ...html, ...login, cookie }, clientCert: false });
  const p = (JSON.parse((await redeem(silent.headers.location, verifierP)).body) as { access_token: string }).access_token;
  // 受信箱の番号を、本人が登録する連絡先として、P で登録する（D-26、D-42）
  const inbox = randomBytes(16).toString("base64url");
  const path = "/contacts/inbox";
  const contact = await call("auth", path, {
    method: "POST",
    headers: { ...JSON_HEADERS, authorization: `DPoP ${p}`, dpop: await dpopProof(privateKey, jwk, "POST", `${origin("auth")}${path}`, p) },
    body: JSON.stringify({ inbox }),
    clientCert: true,
  });
  if (contact.status !== 200) throw new Error(`受信箱の登録に失敗: ${contact.status} ${contact.body}`);

  return {
    status: res.status,
    token: body.access_token,
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    dpopKey: await exportJWK(privateKey),
    jkt: await calculateJwkThumbprint(jwk),
    authenticator,
    inbox,
  };
}

/**
 * 監査の担当の役: 監査の画面（入口の /audit の下）からログインサーバーへ送られ、固定ユーザーでログインし、監査の画面に戻ってから、
 * その受け口を読む（gekko_11 の D-31）。ブラウザと同じ順で、入口を通して進む。
 */
async function auditor(args: { user?: string; path: string }) {
  const html = { accept: "text/html" };
  const audit = (path: string, cookie: string, accept = "text/html") =>
    viaEntry(path, { method: "GET", headers: { accept, ...(cookie ? { cookie } : {}) } });
  const start = await audit("/audit/", "");
  let auditCookie = cookiesOf(start);
  const first = await viaEntry(pathOf(start.headers.location), { method: "GET", headers: html });
  const cookie = cookiesOf(first);
  const action = first.body.match(/action="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  if (!action) return { status: first.status, body: { error: "ログインの画面がない" } };
  const posted = await viaEntry(pathOf(action), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: form({ username: args.user ?? "kansa", password: PASSWORD }),
  });
  if (posted.status !== 302) return { status: posted.status, body: { error: "ログインできない" } };
  const back = await audit(pathOf(posted.headers.location), auditCookie);
  // 監査の担当でない者は、戻ったあとに断られる
  if (back.status !== 302) return { status: back.status, body: { error: "ログインのあとに断られた", location: back.headers.location } };
  auditCookie = cookiesOf(back, auditCookie);
  return reply(await audit(`/audit${args.path}`, auditCookie, "application/json"));
}

/** BFF の役: A を営業 AI エージェントに出す。自分の SVID で mTLS をかけ、htu は内部の名前にする（D-41）。proof は、正しいもの、なし、別の鍵で作ったもの。 */
async function callSalesAgent(args: { path: string; body?: unknown; token: string; dpopKey: JWK; proof?: "good" | "none" | "other-key" }) {
  const htu = `${origin("sales-agent")}${args.path}`;
  const headers: Record<string, string> = { ...JSON_HEADERS, authorization: `DPoP ${args.token}` };
  const proof = args.proof ?? "good";
  if (proof !== "none") {
    const signer: SigningKey =
      proof === "good" ? await importJWK(args.dpopKey, "ES256") : generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const { d: _d, ...publicJwk } = proof === "good" ? args.dpopKey : await exportJWK(signer as KeyObject);
    headers.dpop = await dpopProof(signer, publicJwk, "POST", htu, args.token);
  }
  return reply(await call("sales-agent", args.path, { method: "POST", headers, body: JSON.stringify(args.body ?? {}), clientCert: true }));
}

/** 自分の SVID で、自分のトークン（client_credentials）を受け取る。 */
async function clientCredentials() {
  return reply(
    await call("auth", "/oauth2/token", { method: "POST", headers: FORM, body: form({ grant_type: "client_credentials", client_id: self }), clientCert: true }),
  );
}

/** 自分の SVID で、トークンを替えるよう頼む。 */
async function exchange(args: { subject: string; actor?: string; audience: string; terms?: unknown; clientCert?: boolean }) {
  return reply(
    await call("auth", "/oauth2/token", {
      method: "POST",
      headers: FORM,
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        client_id: self,
        subject_token: args.subject,
        subject_token_type: ACCESS_TOKEN,
        actor_token: args.actor,
        actor_token_type: args.actor ? ACCESS_TOKEN : undefined,
        audience: args.audience,
        scope: "apply",
        authorization_details: args.terms ? JSON.stringify(args.terms) : undefined,
      }),
      clientCert: args.clientCert ?? true,
    }),
  );
}

/** サービスの受け口を、トークンを付けて呼ぶ。clientCert が偽なら、証明書なしで呼ぶ。 */
async function callService(args: { service: string; path?: string; method?: string; token?: string; body?: unknown; clientCert?: boolean }) {
  return reply(
    await call(args.service, args.path ?? "/hop", {
      method: args.method ?? "POST",
      headers: { ...JSON_HEADERS, ...(args.token ? { authorization: `Bearer ${args.token}` } : {}) },
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      clientCert: args.clientCert ?? true,
    }),
  );
}

/** 事務サービスの MCP の道具を、直接呼ぶ（乗っ取られた営業 AI エージェントの役）。stateless の JSON 応答を使う。 */
async function mcp(args: { token: string; tool: string; args?: Record<string, unknown>; clientCert?: boolean }) {
  const r = await call("insurer-mcp", "/mcp", {
    method: "POST",
    headers: { ...JSON_HEADERS, accept: "application/json, text/event-stream", authorization: `Bearer ${args.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: args.tool, arguments: args.args ?? {} } }),
    clientCert: args.clientCert ?? true,
  });
  const out = reply(r) as { status: number; body: any };
  const text = out.body?.result?.content?.[0]?.text;
  return { status: out.status, isError: Boolean(out.body?.result?.isError ?? out.body?.error), body: text ? JSON.parse(text) : out.body };
}

/** 運用の担当の役: 窓口の登録を外し、また戻す。 */
const operator = async (args: { action: "revoke" | "restore"; client: string }) =>
  reply(await call("auth", `/admin/clients/${args.client}/${args.action}`, { method: "POST", clientCert: true }));

/** 監査の役: 契約の記録と直送の記録を読む。 */
const audit = async () => reply(await call("insurer-backend", "/audit/records", { method: "GET", clientCert: true }));

/** 顧客の役: 顧客のアプリの受信箱を、自分の番号で読む。 */
const notices = async (args: { inbox: string }) =>
  reply(await viaEntry(`/api/inbox/${args.inbox}`, { method: "GET", headers: { accept: "application/json" } }));

async function whoami() {
  const pem = readFileSync(`${SVID_DIR}/svid.pem`, "utf8").split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----";
  const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
  return { spiffeId: spiffeId(self), x5t: createHash("sha256").update(der).digest("base64url") };
}

const commands: Record<string, (args: never) => Promise<unknown>> = {
  "customer-setup": customerSetup,
  "call-sales-agent": callSalesAgent,
  "client-credentials": clientCredentials,
  exchange,
  "call-service": callService,
  mcp,
  operator,
  audit,
  auditor,
  notices,
  whoami,
  decode: async (args: { token: string }) => decodeJwt(args.token),
};

const [command, raw] = process.argv.slice(2);
const run = commands[command ?? ""];
if (!run) {
  console.error(`コマンドがない: ${command}`);
  process.exit(2);
}
run(JSON.parse(raw ?? "{}") as never)
  .then((out) => console.log(JSON.stringify(out)))
  .catch((e: Error) => {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  });
