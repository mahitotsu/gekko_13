// 顧客のアプリの BFF（gekko_11 の D-41、RFC 10017 の 6.1 節）。OAuth の機密クライアントとして、ログインサーバーで A と P を受け取り、
// 画面の代わりに営業 AI エージェントと認可サーバーを呼ぶ。トークンと DPoP の鍵は、画面には出さない。
// セッションは、2 つのタスクで共有するため、暗号化して共有のデータベースに置く（段 D の D1-a3。判断 54。packages/state）。
// 画面とは、HttpOnly の Cookie のセッションでつなぐ。顧客の承認（passkey の署名）は、今までどおり画面の端末で行う。
import type { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import { mtlsFetch, type SvidSource } from "../../../packages/spiffe-tls/src/index.ts";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { compactVerify, createRemoteJWKSet, customFetch, SignJWT } from "jose";
import * as oidc from "openid-client";
import { needsRefresh, verifyIdToken } from "../web/checks.ts";
import { state } from "../../../packages/state/src/index.ts";
import { warmKeys } from "../../../packages/token-guard/src/index.ts";

const env = (name: string, fallback?: string) => process.env[name] ?? fallback ?? "";

const trustDomain = () => env("TRUST_DOMAIN", "gekko13.internal");

/** BFF の設定。宛先は、決まった出口だけ（RFC 10017 の 6.1.3.6 節）。 */
const cfg = () => ({
  issuer: env("ISSUER"),
  appOrigin: env("APP_ORIGIN"),
  clientId: "customer-app",
  terms: [{ type: "insurance_application", kinds: ["fixed", "lifetime"], maxBenefit: 1_200_000 }],
  /**
   * ログインサーバーへ送る先の origin。AWS では issuer と同じ公開の名前（CloudFront を通し、TLS でログインサーバーを確かめる）。
   * 手元では、コンテナの名前（平文の HTTP）。パスは issuer のまま送り、Host は issuer の名前にする。
   */
  loginOrigin: env("LOGIN_ORIGIN", new URL(env("ISSUER", "http://localhost")).origin),
  /** 営業 AI エージェント。SVID の mTLS で呼び、相手の SPIFFE ID を確かめる。DPoP の htu にも、この URL を使う。 */
  agentOrigin: env("AGENT_ORIGIN", "https://sales-agent:8443"),
  agentId: `spiffe://${trustDomain()}/svc/sales-agent`,
  /** 認可サーバー（連絡先の登録と、passkey の一覧）。SVID の mTLS で呼ぶ。DPoP の htu にも、この URL を使う。 */
  authOrigin: env("AUTH_ORIGIN", "https://auth:8443"),
  authId: `spiffe://${trustDomain()}/svc/auth`,
  jwtSvidFile: env("JWT_SVID_FILE", "/svid/jwt_svid.token"),
});

/** SVID（spiffe-helper が書いたファイル）。main.ts が起動のときに渡す。 */
let svids: SvidSource | undefined;
export const useSvids = (source: SvidSource) => (svids = source);
const svid = () => {
  if (!svids) throw new Error("SVID を読んでいない");
  return svids;
};

/** セッションの Cookie。Secure、HttpOnly、SameSite=Strict、__Host-Http- の接頭辞（RFC 10017 の 6.1.3.2 節）。 */
const SESSION = "__Host-Http-session";
const LOGIN = "__Host-Http-login";
const COOKIE = { path: "/", secure: true, httpOnly: true, sameSite: "Strict" } as const;
/** ログインの上限（gekko_11 の P-18）と、無操作で捨てるまでの時間。ログインサーバーの設定と揃える。 */
const MAX_AGE_MS = 60 * 60_000;
const IDLE_MS = 30 * 60_000;

/** 共有のデータベースに置くセッション（packages/state が暗号化する）。DPoP の鍵は JWK で持つ（判断 54）。 */
interface StoredSession {
  sub: string;
  idToken: string;
  /** DPoP の鍵の組（JWK）。タスクが止まっても、もう片方のタスクが同じ鍵で proof を作る。 */
  dpopKey: { privateJwk: webcrypto.JsonWebKey; publicJwk: webcrypto.JsonWebKey };
  access: string;
  refresh?: string;
  /** 受信箱の番号を、認可サーバーに登録できたか（gekko_11 の D-26）。P は登録と passkey の一覧の読み取りにだけ使い、持ち続けない（gekko_11 の D-42、D-43）。 */
  inboxRegistered: boolean;
  /** passkey の作成か削除を頼んだときの結果（ログインサーバーの kc_action_status。gekko_11 の D-42、D-43）。 */
  passkeyAction?: PasskeyAction;
  /** ログインサーバーにある、本人の passkey の一覧（gekko_11 の D-43）。読めなかったときは undefined。 */
  passkeys?: Passkeys;
  created: number;
  used: number;
}

/** 動いている間のセッション。保存した形に、鍵（CryptoKey）と DPoP のハンドルを足す。 */
interface Session extends StoredSession {
  sid: string;
  keys: webcrypto.CryptoKeyPair;
  dpop: oidc.DPoPHandle;
}

interface LoginState {
  kind: "apply" | "passkeys";
  verifier: string;
  state: string;
  nonce: string;
  /** P を受け取るときは、ログイン中のセッションに足す。 */
  sid?: string;
  /** 端末の受信箱の番号。P を受け取ったら、認可サーバーに登録する（gekko_11 の D-26）。 */
  inbox?: string;
  /** この端末で、ログインと申込みの署名に使う passkey を登録してもらう（gekko_11 の D-42）。 */
  register?: boolean;
  /** 本人の passkey を消してもらう。値は、ログインサーバーの中の資格情報の ID（gekko_11 の D-43）。 */
  remove?: string;
  at: number;
}

/** 受信箱の番号は、端末が作る推測できない値（gekko_11 の D-26）。 */
const INBOX = /^[A-Za-z0-9_-]{22,64}$/;

type PasskeyResult = "success" | "cancelled" | "error";
/** 本人の passkey の一覧。userHandle は passkey の利用者の ID（base64url）。公開鍵は含まない（gekko_11 の D-43）。 */
export interface Passkeys {
  userHandle: string;
  passkeys: { id: string; ref: string; label: string; created: number; transports?: string[] }[];
}
/** ログインサーバーが戻り先に付ける、登録の結果。値がないか分からなければ、失敗とみなす。 */
export const passkeyResult = (status: string | null): PasskeyResult => (status === "success" || status === "cancelled" ? status : "error");
/** 頼んだ操作（作成か削除）と、その結果。 */
export interface PasskeyAction {
  action: "create" | "delete";
  status: PasskeyResult;
}
/** ログインサーバーの中の資格情報の ID（UUID）。ほかの形は、ログインサーバーに渡さない。 */
const CREDENTIAL_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** セッションの期限。作ってからの上限と、無操作の上限の、早い方。 */
const expiryOf = (s: Pick<StoredSession, "created" | "used">) => Math.min(s.created + MAX_AGE_MS, s.used + IDLE_MS);
const LOGIN_MS = 10 * 60_000;
/** 使った時刻は、1 分より細かくは書き戻さない（要求のたびにデータベースへ書かない）。 */
const TOUCH_MS = 60_000;

const stored = (s: Session): StoredSession => {
  const { sid: _sid, keys: _keys, dpop: _dpop, ...rest } = s;
  return rest;
};

/** 保存した形から、鍵を取り込み、DPoP のハンドルを作り直す。 */
async function revive(sid: string, s: StoredSession): Promise<Session> {
  const ec = { name: "ECDSA", namedCurve: "P-256" };
  const keys = {
    privateKey: await crypto.subtle.importKey("jwk", s.dpopKey.privateJwk, ec, false, ["sign"]),
    publicKey: await crypto.subtle.importKey("jwk", s.dpopKey.publicJwk, ec, true, ["verify"]),
  } as webcrypto.CryptoKeyPair;
  return { ...s, sid, keys, dpop: oidc.getDPoPHandle(client(), keys) };
}

async function save(s: Session) {
  await state().put("session", s.sid, JSON.stringify(stored(s)), expiryOf(s));
}

async function loadSession(sid: string): Promise<Session | undefined> {
  const raw = await state().get("session", sid);
  return raw ? revive(sid, JSON.parse(raw) as StoredSession) : undefined;
}

/** A を更新できない。画面は、ログインし直しへ案内する。 */
class LoginExpired extends Error {}

/**
 * ログインサーバーへ送る fetch。宛先の URL の origin を loginOrigin に替え、Host は元の名前のまま付ける。
 * AWS では loginOrigin が元の URL と同じなので、そのまま公開の名前へ送る。
 */
export function loginFetch(loginOrigin: string): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    const local = new URL(loginOrigin);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = init.body === undefined || init.body === null ? undefined : init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
    const request = local.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        { protocol: local.protocol, host: local.hostname, port: local.port || undefined, servername: local.hostname, method: init.method ?? "GET", path: target.pathname + target.search, headers: { ...Object.fromEntries(headers), host: target.host }, timeout: 15_000 },
        (res) => {
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : v);
          const status = res.statusCode ?? 502;
          resolve(new Response(status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: out }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      if (init.signal) init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")));
      req.end(body);
    });
  }) as typeof fetch;
}

/**
 * ログインサーバーの公開鍵の一覧。ログインサーバーへの出口から取る。1 つを使い回し、期限を切らずに持つ。
 * 知らない kid が来たときだけ取り直す（30 秒に 1 回まで）。起動したら warmLoginKeys ですぐ取っておく（段 D の D1-a3）
 */
let loginKeys: ReturnType<typeof createRemoteJWKSet> | undefined;
function loginJwks() {
  if (!loginKeys) {
    const c = cfg();
    loginKeys = createRemoteJWKSet(new URL(`${c.issuer}/protocol/openid-connect/certs`), {
      [customFetch]: loginFetch(c.loginOrigin),
      cacheMaxAge: Infinity,
      cooldownDuration: 30_000,
    });
  }
  return loginKeys;
}

/** 起動したらすぐ、ログインサーバーの公開鍵を取っておく（取れるまで取り直す。受け始めるのは待たない）。 */
export function warmLoginKeys(log: (o: object) => void): Promise<void> {
  return warmKeys(() => loginJwks().reload(), log);
}

/** ログインサーバーの機密クライアントの設定。クライアント認証は、SPIRE の JWT-SVID（gekko_11 の D-38、D-41）。 */
function client() {
  const c = cfg();
  const base = `${c.issuer}/protocol/openid-connect`;
  const config = new oidc.Configuration(
    { issuer: c.issuer, authorization_endpoint: `${base}/auth`, token_endpoint: `${base}/token`, jwks_uri: `${base}/certs` },
    c.clientId,
    {},
    (_as, _client, body) => {
      body.set("client_id", c.clientId);
      body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-spiffe");
      body.set("client_assertion", readFileSync(c.jwtSvidFile, "utf8").trim());
    },
  );
  // 手元の確かめでは、入口が TLS でない（issuer が http）
  if (c.issuer.startsWith("http:")) oidc.allowInsecureRequests(config);
  config[oidc.customFetch] = (url, options) => loginFetch(c.loginOrigin)(url, options as RequestInit);
  return config;
}

/** ID トークンを確かめる（gekko_11 の G21）。openid-client は既定で署名を確かめないので、自分で確かめる（gekko_11 の D-40）。 */
async function checkIdToken(idToken: string, nonce: string) {
  const c = cfg();
  return verifyIdToken(idToken, loginJwks(), { issuer: c.issuer, clientId: c.clientId, nonce });
}

/** ログインサーバーのログアウトの URL。確かめられる ID トークンだけを示す（gekko_11 の D-33）。示さなければ、ログインサーバーが確認の画面を出す。 */
export async function logoutUrl(idToken: string | undefined, jwks: Parameters<typeof compactVerify>[1]): Promise<string> {
  const { issuer, clientId, appOrigin } = cfg();
  const q = new URLSearchParams({ client_id: clientId, post_logout_redirect_uri: `${appOrigin}/` });
  if (idToken && (await compactVerify(idToken, jwks).catch(() => undefined))) q.set("id_token_hint", idToken);
  return `${issuer}/protocol/openid-connect/logout?${q}`;
}

/** DPoP の proof（RFC 9449）。BFF の鍵で、営業 AI エージェントと認可サーバーへの要求ごとに作る。 */
async function proof(session: Session, htm: string, htu: string, token: string) {
  const jwk = (await crypto.subtle.exportKey("jwk", session.keys.publicKey)) as Record<string, string>;
  const ath = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("base64url");
  return new SignJWT({ htm, htu, jti: crypto.randomUUID(), ath })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! } })
    .setIssuedAt()
    .sign(session.keys.privateKey);
}

const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** Cookie のセッションを読む。期限を過ぎたものは、置き場所が返さない（packages/state）。 */
async function current(c: Context): Promise<Session | undefined> {
  const sid = getCookie(c, SESSION);
  const session = sid ? await loadSession(sid) : undefined;
  if (session && Date.now() - session.used > TOUCH_MS) {
    session.used = Date.now();
    await save(session);
  }
  return session;
}

/**
 * A を更新する（gekko_11 の P-18）。使い回すと、ログインサーバーがログインごと止めるので、セッションごとに 1 つしか走らせない。
 * 2 つのタスクで共有するので、セッションの行をロックして更新する。ロックを待つ間に、ほかの要求が更新を済ませていれば、それを使う（判断 54）。
 * 更新にもクライアント認証が要るので、更新のトークンを盗んでも、顧客のアプリの身元がなければ使えない（gekko_11 の G31）。
 */
async function renew(session: Session): Promise<void> {
  const seen = session.access;
  const latest = await state().locked("session", session.sid, async (raw) => {
    if (!raw) throw new LoginExpired("セッションがない");
    const now = JSON.parse(raw) as StoredSession;
    if (now.access !== seen) return { result: now };
    if (!now.refresh) throw new LoginExpired("更新のトークンがない");
    const tokens = await oidc.refreshTokenGrant(client(), now.refresh, undefined, { DPoP: session.dpop }).catch((e: Error) => {
      throw new LoginExpired(`更新できない: ${e.message}`);
    });
    const next = { ...now, access: tokens.access_token, refresh: tokens.refresh_token ?? now.refresh };
    return { value: JSON.stringify(next), expiresAt: expiryOf(next), result: next };
  });
  session.access = latest.access;
  session.refresh = latest.refresh;
}

/** CSRF の対策（RFC 10017 の 6.1.3.3 節）。SameSite=Strict に加え、事前確認が要るヘッダーと、自分の origin を求める。 */
function sameOrigin(c: Context): boolean {
  if (c.req.header("x-bff") !== "1") return false;
  const origin = c.req.header("origin");
  return origin === undefined || origin === cfg().appOrigin;
}

async function startLogin(c: Context, kind: LoginState["kind"], extra: Pick<LoginState, "sid" | "inbox" | "register" | "remove"> = {}) {
  const config = client();
  const login: LoginState = { kind, verifier: oidc.randomPKCECodeVerifier(), state: random(), nonce: random(), ...extra, at: Date.now() };
  const id = random();
  await state().put("login", id, JSON.stringify(login), login.at + LOGIN_MS);
  setCookie(c, LOGIN, id, { ...COOKIE, maxAge: 600 });
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${cfg().appOrigin}/callback`,
    scope: kind === "apply" ? "openid apply" : "openid passkeys",
    code_challenge: await oidc.calculatePKCECodeChallenge(login.verifier),
    code_challenge_method: "S256",
    state: login.state,
    nonce: login.nonce,
    ...(kind === "apply" ? { authorization_details: JSON.stringify(cfg().terms) } : { prompt: "none" }),
    // passkey の作成を頼まれたときは、ログインサーバーの画面で登録してもらう（Keycloak の AIA。gekko_11 の D-42、D-43）
    ...(login.register ? { kc_action: "webauthn-register-passwordless" } : {}),
    // 削除を頼まれたときは、ログインサーバーが確認の画面を出し、本人に確かめてから消す（Keycloak の delete_credential。gekko_11 の D-43）
    ...(login.remove ? { kc_action: `delete_credential:${login.remove}` } : {}),
  });
  return c.redirect(url.href, 302);
}

/** 認可サーバーを、P と DPoP の proof で呼ぶ。宛先と経路は決まったものだけ（gekko_11 の D-42）。 */
async function callAuth(session: Session, p: string, method: "GET" | "POST", path: "/contacts/inbox" | "/passkeys/mine", body?: unknown) {
  const { authOrigin, authId } = cfg();
  const url = `${authOrigin}${path}`;
  // 認可サーバー（Spring）は、Host と TLS から自分の URL を組み立て、DPoP の htu と照らす。mTLS で直接呼ぶので、転送のヘッダーは要らない
  return mtlsFetch(svid(), authId)(url, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      accept: "application/json",
      authorization: `DPoP ${p}`,
      dpop: await proof(session, method, url, p),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => undefined);
}

/** 受信箱の番号を、本人の連絡先として、認可サーバーに登録する（gekko_11 の D-26）。 */
async function registerInbox(session: Session, p: string, inbox: string): Promise<boolean> {
  return Boolean((await callAuth(session, p, "POST", "/contacts/inbox", { inbox }))?.ok);
}

/** 本人の passkey の一覧を、認可サーバーから読む（gekko_11 の D-43）。読めなければ undefined。 */
async function readPasskeys(session: Session, p: string): Promise<Passkeys | undefined> {
  const res = await callAuth(session, p, "GET", "/passkeys/mine");
  if (res?.ok) return (await res.json()) as Passkeys;
  // 読めなかった理由を残す（トークンは書かない）
  console.log(JSON.stringify({ at: new Date().toISOString(), svc: "customer-app", ev: "passkeys_unavailable", status: res?.status, body: (await res?.text())?.slice(0, 300) }));
  return undefined;
}

export function addBff(app: Hono) {
  // ログインへ送る（A を受け取る）。端末の受信箱の番号と、passkey を作るかを受け取る
  app.get("/bff/login", (c) => {
    const inbox = c.req.query("inbox");
    const remove = c.req.query("delete");
    return startLogin(c, "apply", {
      inbox: inbox && INBOX.test(inbox) ? inbox : undefined,
      ...(remove && CREDENTIAL_REF.test(remove) ? { remove } : { register: c.req.query("register") === "1" }),
    });
  });

  /** 戻り先。認可コードを、JWT-SVID のクライアント認証と DPoP で替える。奪われた認可コードは、顧客のアプリの身元がなければ替えられない。 */
  app.get("/callback", async (c, next) => {
    const url = new URL(c.req.url, cfg().appOrigin);
    if (!url.searchParams.has("code") && !url.searchParams.has("error")) return next();
    const id = getCookie(c, LOGIN);
    // ログインの途中の情報は 1 回だけ使う。2 つのタスクに同時に届いても、渡すのは片方だけ（packages/state の take）
    const raw = id ? await state().take("login", id) : undefined;
    const login = raw ? (JSON.parse(raw) as LoginState) : undefined;
    deleteCookie(c, LOGIN, COOKIE);
    const fail = (message: string) => c.redirect(`/?login_error=${encodeURIComponent(message)}`, 302);
    if (!login) return fail("ログインの情報がない");
    if (url.searchParams.has("error")) return fail(`ログインできない: ${url.searchParams.get("error")}`);
    try {
      const existing = login.sid ? await loadSession(login.sid) : undefined;
      // DPoP の鍵は、共有のデータベースに暗号化して置くので、取り出せる形で作る（判断 54）
      const keys = existing?.keys ?? ((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair);
      const config = client();
      const dpop = existing?.dpop ?? oidc.getDPoPHandle(config, keys);
      const callback = new URL(`${cfg().appOrigin}/callback${url.search}`);
      const tokens = await oidc.authorizationCodeGrant(config, callback, { pkceCodeVerifier: login.verifier, expectedState: login.state, expectedNonce: login.nonce, idTokenExpected: true }, undefined, { DPoP: dpop });
      if (!tokens.id_token) return fail("ID トークンを受け取れない");
      const { sub } = await checkIdToken(tokens.id_token, login.nonce);
      if (login.kind === "passkeys") {
        if (!existing || existing.sub !== sub) return fail("ログイン中の利用者と違う");
        // P で、端末の受信箱の番号を、本人の連絡先として登録する（gekko_11 の D-26、D-42）。P は持ち続けない
        if (login.inbox) existing.inboxRegistered = await registerInbox(existing, tokens.access_token, login.inbox);
        // 本人の passkey の一覧も、同じ P で読む。画面は、端末に一覧を伝え、空なら作成を促す（gekko_11 の D-43）
        existing.passkeys = await readPasskeys(existing, tokens.access_token);
        await save(existing);
        return c.redirect("/", 302);
      }
      const sid = random();
      const now = Date.now();
      // passkey の作成か削除を頼んだときは、ログインサーバーが結果（success、cancelled、error）を戻り先に付ける。取り消しや失敗でも、ログインは済んでいる
      const status = passkeyResult(url.searchParams.get("kc_action_status"));
      const passkeyAction: PasskeyAction | undefined = login.register ? { action: "create", status } : login.remove ? { action: "delete", status } : undefined;
      const dpopKey = { privateJwk: await crypto.subtle.exportKey("jwk", keys.privateKey), publicJwk: await crypto.subtle.exportKey("jwk", keys.publicKey) };
      await save({ sid, sub, idToken: tokens.id_token, dpopKey, keys, dpop, access: tokens.access_token, refresh: tokens.refresh_token, inboxRegistered: false, passkeyAction, created: now, used: now });
      setCookie(c, SESSION, sid, COOKIE);
      // 続けて、受信箱の登録に使う P を受け取る
      return startLogin(c, "passkeys", { sid, inbox: login.inbox });
    } catch (e) {
      return fail(`ログインできない: ${(e as Error).message}`);
    }
  });

  /** 画面に渡すのは、利用者の名前と、受信箱を登録できたかと、passkey の登録の結果と一覧だけ。トークンは渡さない。 */
  app.get("/bff/session", async (c) => {
    const session = await current(c);
    if (!session) return c.json({ error: "ログインしていない" }, 401);
    // passkey の作成か削除の結果は、ログインの後に 1 度だけ渡す
    const passkeyAction = session.passkeyAction;
    if (passkeyAction) {
      session.passkeyAction = undefined;
      await save(session);
    }
    return c.json({ sub: session.sub, inboxRegistered: session.inboxRegistered, ...(passkeyAction ? { passkeyAction } : {}), ...(session.passkeys ? { passkeys: session.passkeys } : {}) });
  });

  /**
   * サインアウト（OpenID Connect の RP-Initiated Logout。gekko_11 の D-33）。セッションを消し、画面には、ログインサーバーへ送る URL を返す。
   * ログインサーバーが再起動して鍵が替わると、前の ID トークンはエラーの画面になるので、確かめられるものだけを示す。
   */
  app.post("/bff/logout", async (c) => {
    if (!sameOrigin(c)) return c.json({ error: "要求の出どころを確かめられない" }, 403);
    const session = await current(c);
    const sid = getCookie(c, SESSION);
    if (sid) await state().delete("session", sid);
    deleteCookie(c, SESSION, COOKIE);
    return c.json({ url: await logoutUrl(session?.idToken, loginJwks()) });
  });

  /**
   * 営業 AI エージェントとの AG-UI を、A と DPoP の proof を付けて中継する（gekko_11 の D-29）。回の前に、A の残りが短ければ更新し、
   * 401 なら、1 度だけ更新して送り直す（gekko_11 の P-18）。401 は受け口で断られるので、回は始まっていない。
   */
  app.post("/bff/agui", async (c) => {
    if (!sameOrigin(c)) return c.json({ error: "要求の出どころを確かめられない" }, 403);
    const session = await current(c);
    if (!session) return c.json({ error: "ログインしていない" }, 401);
    const body = await c.req.text();
    const { agentOrigin, agentId } = cfg();
    const send = async () =>
      mtlsFetch(svid(), agentId, 60_000)(`${agentOrigin}/agui`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `DPoP ${session.access}`,
          dpop: await proof(session, "POST", `${agentOrigin}/agui`, session.access),
        },
        body,
        signal: c.req.raw.signal,
      });
    try {
      if (needsRefresh(session.access, Date.now())) await renew(session);
      let res = await send();
      if (res.status === 401) {
        await res.body?.cancel();
        await renew(session);
        res = await send();
      }
      return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-cache" } });
    } catch (e) {
      if (e instanceof LoginExpired) return c.json({ error: "ログインの有効期間が切れた" }, 401);
      // 営業 AI エージェントに、送り直しても届かなかった（止まったタスクに当たり続けたなど）。画面は、同じ答えをもう一度送れる（段 D の D1-a3）
      console.log(JSON.stringify({ at: new Date().toISOString(), svc: "customer-app", ev: "agent_unavailable", error: (e as Error).message }));
      return c.json({ error: "営業 AI エージェントに一時的につながらない。少し待って、もう一度送ってください" }, 503);
    }
  });

}
