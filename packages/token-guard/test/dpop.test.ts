// DPoP の受け口の確かめ（営業 AI エージェント。gekko_11 の防御 G26）。proof の方式は、送信者の秘密鍵の署名（ES256）に限る。
// gekko_11 の packages/token-guard/test/dpop.test.ts を、関数の形に合わせて写した。
import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, createLocalJWKSet, exportJWK, generateKeyPair, generateSecret, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

type KeyLike = Parameters<SignJWT["sign"]>[0];
import { createGuard } from "../src/index.ts";

const ISSUER = "https://login.example/login/realms/insurer";
const URL_AGUI = "https://sales-agent:8443/agui";
const CALLER = "spiffe://gekko13.internal/svc/customer-app";
let signToken: (jkt: string) => Promise<string>;
let guard: ReturnType<typeof createGuard>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  guard = createGuard({ service: "sales-agent", issuer: ISSUER, keys: createLocalJWKSet({ keys: [jwk] }), ingress: "dpop", allowedCallers: [CALLER] });
  signToken = (jkt) =>
    new SignJWT({ sub: "alice", aud: "sales-agent", cnf: { jkt } })
      .setProtectedHeader({ alg: "RS256", kid: "k1", typ: "at+jwt" })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
});

const ath = (token: string) => createHash("sha256").update(token).digest("base64url");

/** proof を、与えた鍵と方式で作り、受け口に出す。 */
async function attempt(alg: string, key: KeyLike, jwk: JWK, o: { htu?: string; caller?: string } = {}) {
  const token = await signToken(await calculateJwkThumbprint(jwk));
  const dpop = await new SignJWT({ htm: "POST", htu: o.htu ?? URL_AGUI, ath: ath(token), jti: randomUUID() })
    .setProtectedHeader({ alg, typ: "dpop+jwt", jwk })
    .setIssuedAt()
    .sign(key);
  try {
    await guard({ method: "POST", url: URL_AGUI, authorization: `DPoP ${token}`, dpop }, { spiffeId: o.caller ?? CALLER });
    return "通る";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("DPoP の proof の方式（gekko_11 の G26）", () => {
  it("顧客のアプリの BFF と同じ ES256 の proof は通る", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    expect(await attempt("ES256", privateKey, await exportJWK(publicKey))).toBe("通る");
  });

  it("共有の鍵の HS256 の proof は、トークンがその鍵に結ばれていても断る", async () => {
    const secret = await generateSecret("HS256", { extractable: true });
    expect(await attempt("HS256", secret, await exportJWK(secret))).toMatch(/alg が ES256 でない/);
  });

  it("htu が違う proof と、顧客のアプリでない相手は断る", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    expect(await attempt("ES256", privateKey, await exportJWK(publicKey), { htu: "https://other:8443/agui" })).toMatch(/htu が違う/);
    expect(await attempt("ES256", privateKey, await exportJWK(publicKey), { caller: "spiffe://gekko13.internal/svc/intruder" })).toMatch(/呼んでよい相手ではない/);
  });
});
