// サービスのトークンの確かめの、共通の試験の例を作る（段 D の D1-a2-2）。
// 同じ例を、TypeScript（packages/token-guard）、Python（事務サービス）、Java（保険会社のシステム）の試験が読み、
// 3 つの確かめが同じ判定をすることを確かめる（docs/design-decisions.md）。
// 鍵は、例を作るたびに新しく作る試験の専用のもので、どのサービスの鍵でもない。公開鍵だけを例に入れる。
// 使い方: node scripts/make-vectors.ts（packages/token-guard/vectors/service-token.json を書き直す）
import { writeFileSync } from "node:fs";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";

const NOW = 1_795_000_000;
const ISSUER = "https://auth:8443";
const SERVICE = "insurer-mcp";
const CALLER = "spiffe://gekko13.internal/svc/sales-agent";
const PEER_X5T = "q5PeerCertificateThumbprint0000000000000000";
const OTHER_X5T = "zzOtherCertificateThumbprint000000000000000";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "vectors", alg: "RS256", use: "sig" };

const base: JWTPayload = {
  iss: ISSUER,
  sub: "alice",
  aud: SERVICE,
  iat: NOW - 10,
  exp: NOW + 60,
  jti: "vector-jti",
  scope: "apply",
  cnf: { "x5t#S256": PEER_X5T },
  act: { sub: "sales-agent" },
};

const sign = (claims: JWTPayload, o: { typ?: string; key?: Parameters<SignJWT["sign"]>[0]; kid?: string } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: o.kid ?? "vectors", typ: o.typ ?? "at+jwt" }).sign(o.key ?? privateKey);

const without = (k: string) => Object.fromEntries(Object.entries(base).filter(([key]) => key !== k)) as JWTPayload;
const peer = { spiffeId: CALLER, x5tS256: PEER_X5T };
const valid = await sign(base);
const [h, p] = valid.split(".");
const tamperedPayload = Buffer.from(JSON.stringify({ ...base, sub: "mallory" })).toString("base64url");
const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt" })).toString("base64url")}.${p}.`;

const cases = [
  { name: "正しいトークン", authorization: `Bearer ${valid}`, peer, expect: "ok" },
  { name: "aud が配列で、自分を含む", authorization: `Bearer ${await sign({ ...base, aud: [SERVICE, "other"] })}`, peer, expect: "ok" },
  { name: "相手の証明書がない", authorization: `Bearer ${valid}`, peer: {}, expect: "no_peer" },
  { name: "呼んでよい相手ではない", authorization: `Bearer ${valid}`, peer: { spiffeId: "spiffe://gekko13.internal/svc/intruder", x5tS256: PEER_X5T }, expect: "wrong_caller" },
  { name: "Authorization がない", peer, expect: "no_token" },
  { name: "Bearer でない", authorization: `DPoP ${valid}`, peer, expect: "no_token" },
  { name: "別の鍵の署名", authorization: `Bearer ${await sign(base, { key: other.privateKey })}`, peer, expect: "bad_signature" },
  { name: "中身を書き換えた", authorization: `Bearer ${h}.${tamperedPayload}.${valid.split(".")[2]}`, peer, expect: "bad_signature" },
  { name: "署名なし（alg が none）", authorization: `Bearer ${none}`, peer, expect: "bad_signature" },
  { name: "typ が at+jwt でない", authorization: `Bearer ${await sign(base, { typ: "JWT" })}`, peer, expect: "bad_typ" },
  { name: "発行者が違う", authorization: `Bearer ${await sign({ ...base, iss: "https://login.example/realms/insurer" })}`, peer, expect: "bad_issuer" },
  { name: "宛先が違う", authorization: `Bearer ${await sign({ ...base, aud: "insurer-backend" })}`, peer, expect: "bad_audience" },
  { name: "期限が切れた", authorization: `Bearer ${await sign({ ...base, iat: NOW - 120, exp: NOW - 1 })}`, peer, expect: "expired" },
  { name: "別の証明書に結ばれている", authorization: `Bearer ${await sign({ ...base, cnf: { "x5t#S256": OTHER_X5T } })}`, peer, expect: "not_bound" },
  { name: "証明書に結ばれていない", authorization: `Bearer ${await sign(without("cnf"))}`, peer, expect: "not_bound" },
];

const out = {
  description:
    "サービスのトークン（B、C）の受け口の確かめの共通の例。scripts/make-vectors.ts が作る。鍵は試験の専用。" +
    "確かめる順: 相手の SPIFFE ID → Authorization: Bearer → 署名 → typ → iss → aud → exp → cnf の x5t#S256 と相手の証明書",
  now: NOW,
  service: SERVICE,
  issuer: ISSUER,
  allowedCallers: [CALLER],
  jwks: { keys: [jwk] },
  cases,
};
writeFileSync(new URL("../packages/token-guard/vectors/service-token.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`${cases.length} 件の例を書いた`);
