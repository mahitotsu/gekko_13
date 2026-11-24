// 受け口でトークンを確かめ、出口で次の段のトークンに替える（gekko_11 の token-guard。architecture の 2-2、防御 G26、G27）。
// gekko_11 は Envoy の ext_authz のサーバーだったが、gekko_13 は Envoy を置かないので、各アプリの中で関数として使う
// （docs/design-decisions.md の 1 行目）。相手の SPIFFE ID と証明書のサムプリントは、アプリが終えた TLS の接続から取る。
// 拒む理由の符号は、Python（事務サービス）と Java（保険会社のシステム）の確かめとそろえる。共通の例は vectors/ にある。
import { createHash } from "node:crypto";
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  errors,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

/** 拒む理由の符号。3 つの言語でそろえる（vectors/README の表）。 */
export type Reason =
  | "no_peer"
  | "wrong_caller"
  | "no_token"
  | "bad_token"
  | "bad_signature"
  | "bad_typ"
  | "bad_issuer"
  | "bad_audience"
  | "expired"
  | "not_bound"
  | "bad_dpop";

export class Refusal extends Error {
  readonly status: 401 | 403;
  readonly reason: Reason;
  constructor(status: 401 | 403, reason: Reason, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/** TLS で確かめた相手。証明書のサムプリントは、RFC 8705 の x5t#S256（DER の SHA-256 の base64url）。 */
export interface Peer {
  spiffeId?: string;
  x5tS256?: string;
}

export type Claims = JWTPayload & { cnf?: { jkt?: string; "x5t#S256"?: string }; act?: unknown; sub: string };

export interface GuardOptions {
  /** このサービスの名前。受け取るトークンの aud。 */
  service: string;
  /** 受け取るトークンの発行者。営業 AI エージェントはログインサーバー（A）、ほかは認可サーバー（B、C）。 */
  issuer: string;
  keys: JWTVerifyGetKey;
  /** 受け口で求める証明: 顧客のアプリの BFF からは DPoP、サービスからは mTLS の証明書（gekko_11 の D-7）。 */
  ingress: "dpop" | "mtls";
  /** 呼んでよい相手の SPIFFE ID（G27）。 */
  allowedCallers: string[];
  /** 今の時刻（秒）。共通の例で、時刻を固定するために渡す。 */
  now?: () => number;
}

export interface IngressRequest {
  method: string;
  /** DPoP の htu と照らす URL。 */
  url: string;
  authorization?: string;
  dpop?: string;
}

/** 証明書（DER）から x5t#S256 を作る。 */
export const x5tS256 = (der: Buffer) => createHash("sha256").update(der).digest("base64url");

/**
 * サービスのトークンを確かめる（署名、typ、iss、aud、exp）。確かめる順は、3 つの言語でそろえる。
 * 失敗の理由は、jose の誤りの種類から決める。
 */
export async function verifyToken(token: string, o: Pick<GuardOptions, "service" | "issuer" | "keys" | "now">): Promise<Claims> {
  try {
    const { payload } = await jwtVerify(token, o.keys, {
      algorithms: ["RS256"],
      typ: "at+jwt",
      issuer: o.issuer,
      audience: o.service,
      requiredClaims: ["sub", "exp"],
      clockTolerance: 0,
      currentDate: o.now ? new Date(o.now() * 1000) : undefined,
    });
    return payload as Claims;
  } catch (e) {
    throw new Refusal(401, reasonOf(e), `トークンを確かめられない: ${(e as Error).message}`);
  }
}

function reasonOf(e: unknown): Reason {
  if (e instanceof errors.JWTExpired) return "expired";
  if (e instanceof errors.JWTClaimValidationFailed) {
    if (e.claim === "iss") return "bad_issuer";
    if (e.claim === "aud") return "bad_audience";
    if (e.claim === "typ") return "bad_typ";
    return "bad_token";
  }
  if (e instanceof errors.JWSSignatureVerificationFailed || e instanceof errors.JWKSNoMatchingKey || e instanceof errors.JOSEAlgNotAllowed) {
    return "bad_signature";
  }
  return "bad_token";
}

/** 受け口の確かめ。相手 → トークン → 結び付けの順に確かめ、確かめた主張を返す。 */
export function createGuard(o: GuardOptions) {
  const seenJti = new Map<string, number>();
  return async (req: IngressRequest, peer: Peer): Promise<{ token: string; claims: Claims; peer: Peer }> => {
    if (!peer.spiffeId) throw new Refusal(401, "no_peer", "相手の証明書がない");
    if (!o.allowedCallers.includes(peer.spiffeId)) throw new Refusal(403, "wrong_caller", `呼んでよい相手ではない: ${peer.spiffeId}`);
    const scheme = o.ingress === "dpop" ? "DPoP" : "Bearer";
    const token = req.authorization?.match(new RegExp(`^${scheme} (\\S+)$`))?.[1];
    if (!token) throw new Refusal(401, "no_token", `Authorization: ${scheme} がない`);
    const claims = await verifyToken(token, o);
    if (o.ingress === "mtls") {
      const bound = claims.cnf?.["x5t#S256"];
      if (!bound || !peer.x5tS256 || bound !== peer.x5tS256) throw new Refusal(401, "not_bound", "トークンが、相手の証明書に結ばれていない");
    } else {
      await checkDpop(req, token, claims.cnf?.jkt, seenJti, o.now);
    }
    return { token, claims, peer };
  };
}

const DPOP_ALG = "ES256";

/** DPoP の proof を確かめる（RFC 9449 の 4.3）。顧客のアプリの BFF は ES256 で作る。 */
async function checkDpop(req: IngressRequest, token: string, jkt: string | undefined, seen: Map<string, number>, now?: () => number) {
  if (!req.dpop) throw new Refusal(401, "bad_dpop", "DPoP の proof がない");
  if (!jkt) throw new Refusal(401, "not_bound", "トークンが、DPoP の鍵に結ばれていない");
  try {
    const header = decodeProtectedHeader(req.dpop);
    const jwk = header.jwk as JWK | undefined;
    if (!jwk) throw new Error("jwk がない");
    if (header.alg !== DPOP_ALG) throw new Error(`alg が ${DPOP_ALG} でない: ${String(header.alg)}`);
    const { payload } = await jwtVerify(req.dpop, await importJWK(jwk, DPOP_ALG), {
      algorithms: [DPOP_ALG],
      typ: "dpop+jwt",
      maxTokenAge: "60s",
      currentDate: now ? new Date(now() * 1000) : undefined,
    });
    if (payload.htm !== req.method) throw new Error("htm が違う");
    if (payload.htu !== req.url) throw new Error(`htu が違う: ${String(payload.htu)}`);
    if (payload.ath !== createHash("sha256").update(token).digest("base64url")) throw new Error("ath が違う");
    if ((await calculateJwkThumbprint(jwk)) !== jkt) throw new Error("鍵が、トークンの cnf.jkt と違う");
    const t = Date.now();
    for (const [k, exp] of seen) if (exp < t) seen.delete(k);
    if (!payload.jti || seen.has(payload.jti)) throw new Error("jti が使い回された");
    seen.set(payload.jti, t + 120_000);
  } catch (e) {
    throw new Refusal(401, "bad_dpop", `DPoP の proof を確かめられない: ${(e as Error).message}`);
  }
}

const ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token";

/**
 * 出口の替え（gekko_11 の D-7 の替える段の手順）。認可サーバーへは、自分の SVID の mTLS で呼ぶ（tls_client_auth）。
 * actor_token は、自分の証明書に結んだ自分のトークンである。SVID が入れ替わると、前の証明書に結んだトークンは使えないので、
 * 替えるたびに取り直す。authFetch は、認可サーバーの SPIFFE ID を確かめる mtlsFetch を渡す。
 */
export async function exchangeForNext(o: { authFetch: typeof fetch; authOrigin: string; service: string; next: string; subjectToken: string }): Promise<string> {
  const tokenRequest = async (params: Record<string, string>) => {
    const res = await o.authFetch(`${o.authOrigin}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: o.service, ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`認可サーバーが拒否した: ${res.status} ${body.error ?? ""} ${body.error_description ?? ""}`);
    return body.access_token;
  };
  const actorToken = await tokenRequest({ grant_type: "client_credentials" });
  return tokenRequest({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: o.subjectToken,
    subject_token_type: ACCESS_TOKEN,
    actor_token: actorToken,
    actor_token_type: ACCESS_TOKEN,
    audience: o.next,
    // A の範囲（openid を含む）のうち、取り次ぎに要る範囲だけを求める
    scope: "apply",
  });
}

/**
 * トークンの鍵を、起動したらすぐ取り、取れるまで間を延ばして取り直す（段 D の D1-a3）。受け始めるのは待たない。
 * 0 から起こすと、ログインサーバーより先に起きることがあり、待つとヘルスチェックで入れ替えられるためである。
 * 鍵を持たないまま要求を受けると、その要求の中で取りに行くことになり、送り先が止まった直後には待たされる（2026-11-24 の AWS）。
 * 戻り値は、鍵が取れた時点で解決する Promise（試験で使う）。
 */
export function warmKeys(reload: () => Promise<void>, log: (o: object) => void, maxDelayMs = 10_000, firstDelayMs = 1_000): Promise<void> {
  return (async () => {
    for (let delay = firstDelayMs; ; delay = Math.min(delay * 2, maxDelayMs)) {
      try {
        await reload();
        log({ ev: "keys_ready" });
        return;
      } catch (e) {
        log({ ev: "keys_retry", error: (e as Error).message, inMs: delay });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  })();
}
