// 委任のトークンを確かめ、mTLS で確かめた相手（SPIFFE ID）と、トークンの呼び出し元（act.client_id）を照合する。
// Cognito の token exchange では、client_id は交換を要求した client、act.client_id は actor の client になり、
// 両者は食い違いうる（gekko_12 の実測 1-5）。そのため、両方の一致と、SPIFFE ID との対応を確かめる。
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface Policy {
  issuer: string;
  /** 受け入れる相手の SPIFFE ID と、その相手の Cognito の app client ID の対応。ここにない相手は拒む。 */
  callers: Record<string, string>;
  /** この受け口で要る scope。 */
  requiredScope: string;
}

export interface Claims extends JWTPayload {
  sub: string;
  client_id: string;
  scope: string;
  token_use: string;
  act?: { client_id?: string; sub?: string };
}

export type Verdict =
  | { ok: true; claims: Claims; caller: string }
  | { ok: false; status: 401 | 403; reason: string };

/** 署名を確かめた後の判定。署名の検証から分け、単体で確かめられるようにする。 */
export function judge(payload: JWTPayload, peerId: string, policy: Policy): Verdict {
  const c = payload as Partial<Claims>;
  if (c.token_use !== "access") return { ok: false, status: 401, reason: "not_access_token" };
  if (typeof c.sub !== "string" || typeof c.client_id !== "string" || typeof c.scope !== "string") {
    return { ok: false, status: 401, reason: "missing_claims" };
  }
  const expected = policy.callers[peerId];
  if (expected === undefined) return { ok: false, status: 403, reason: "caller_not_allowed" };
  const actor = c.act?.client_id;
  if (typeof actor !== "string") return { ok: false, status: 403, reason: "not_delegated" };
  if (actor !== c.client_id) return { ok: false, status: 403, reason: "client_actor_mismatch" };
  if (actor !== expected) return { ok: false, status: 403, reason: "peer_actor_mismatch" };
  if (!c.scope.split(" ").includes(policy.requiredScope)) return { ok: false, status: 403, reason: "insufficient_scope" };
  return { ok: true, claims: c as Claims, caller: actor };
}

export function createVerifier(policy: Policy, jwksUrl: string, keys?: JWTVerifyGetKey) {
  const jwks = keys ?? createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  return async (authorization: string | undefined, peerId: string): Promise<Verdict> => {
    const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(authorization ?? "");
    if (!m) return { ok: false, status: 401, reason: "no_token" };
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(m[1], jwks, { issuer: policy.issuer, algorithms: ["RS256"] }));
    } catch {
      return { ok: false, status: 401, reason: "invalid_token" };
    }
    return judge(payload, peerId, policy);
  };
}

/** client_credentials で actor のトークンを得て、受け取ったトークンを交換する（RFC 8693）。 */
export async function exchange(o: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  subjectToken: string;
  actorToken: string;
  scope: string;
}): Promise<string> {
  const res = await fetch(o.tokenUrl, {
    method: "POST",
    headers: { authorization: basic(o.clientId, o.clientSecret), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: o.subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      actor_token: o.actorToken,
      actor_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: o.scope,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`交換に失敗: ${res.status} ${body.error ?? ""}`);
  return body.access_token;
}

/** client_credentials の actor のトークン。期限の 60 秒前まで使い回す。 */
export function actorTokenSource(o: { tokenUrl: string; clientId: string; clientSecret: string; scope: string }) {
  let cached: { token: string; exp: number } | undefined;
  return async (): Promise<string> => {
    if (cached && cached.exp - 60 > Date.now() / 1000) return cached.token;
    const res = await fetch(o.tokenUrl, {
      method: "POST",
      headers: { authorization: basic(o.clientId, o.clientSecret), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: o.scope }),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`actor のトークンを得られない: ${res.status} ${body.error ?? ""}`);
    cached = { token: body.access_token, exp: Date.now() / 1000 + (body.expires_in ?? 300) };
    return cached.token;
  };
}

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
