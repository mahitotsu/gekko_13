// ローカルでだけ使う、Cognito の token exchange の模擬。トークンの形は gekko_12 の実測に合わせる。
// - client_credentials のトークン: sub と client_id が client。
// - 交換したトークン: sub は利用者、client_id はリクエストした client、act.client_id は actor の client（実測 1-5）。
//   act は入れ子にせず、最後の actor で上書きする（実測 1-3）。有効期限は交換元から延ばさない（実測 1-4）。
// - リクエストした scope が交換元か client の許可になければ、削らずに invalid_grant で拒む（実測 1-2）。
// 本物の Cognito に替えても、サービスの側は設定だけで済むようにする。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, createLocalJWKSet, type JWTPayload } from "jose";
import { env, log } from "../../_shared/src/env.ts";

const ISSUER = env("ISSUER");
const USER_CLIENT = env("USER_CLIENT_ID");
/** {client_id: {secret, scopes}} */
const CLIENTS = JSON.parse(env("CLIENTS")) as Record<string, { secret: string; scopes: string[] }>;

const { publicKey, privateKey } = await generateKeyPair("RS256");
const kid = randomUUID();
const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
const jwks = createLocalJWKSet({ keys: [jwk] });

const sign = (claims: JWTPayload, exp: number) =>
  new SignJWT({ ...claims, token_use: "access", jti: randomUUID() })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);

const now = () => Math.floor(Date.now() / 1000);

async function read(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const send = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

function client(req: IncomingMessage): string | undefined {
  const m = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return undefined;
  const [id, secret] = Buffer.from(m[1], "base64").toString("utf8").split(":").map(decodeURIComponent);
  return CLIENTS[id]?.secret === secret ? id : undefined;
}

async function verify(token: string) {
  const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
  if (payload.token_use !== "access") throw new Error("not access");
  return payload as JWTPayload & { client_id: string; scope: string; origin_jti?: string };
}

async function token(req: IncomingMessage, res: ServerResponse) {
  const id = client(req);
  if (!id) return send(res, 401, { error: "invalid_client" });
  const form = new URLSearchParams(await read(req));
  const scopes = (form.get("scope") ?? "").split(" ").filter(Boolean);
  const allowed = CLIENTS[id].scopes;
  if (scopes.some((s) => !allowed.includes(s))) return send(res, 400, { error: "invalid_scope" });

  if (form.get("grant_type") === "client_credentials") {
    const exp = now() + 3600;
    return send(res, 200, { access_token: await sign({ sub: id, client_id: id, scope: scopes.join(" ") }, exp), expires_in: 3600, token_type: "Bearer" });
  }
  if (form.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange") {
    let subject, actor;
    try {
      subject = await verify(form.get("subject_token") ?? "");
      actor = await verify(form.get("actor_token") ?? "");
    } catch {
      return send(res, 400, { error: "invalid_grant" });
    }
    // M2M のトークンは交換元にできない（実測 1-1）
    if (subject.sub === subject.client_id) return send(res, 400, { error: "invalid_request" });
    if (actor.sub !== actor.client_id) return send(res, 400, { error: "invalid_grant" });
    const have = subject.scope.split(" ");
    if (scopes.length === 0 || scopes.some((s) => !have.includes(s))) return send(res, 400, { error: "invalid_grant" });
    const exp = (subject.exp ?? now()) - 1;
    const claims = {
      sub: subject.sub,
      client_id: id,
      scope: scopes.join(" "),
      act: { sub: actor.sub, client_id: actor.client_id },
      origin_jti: subject.origin_jti ?? subject.jti,
    };
    log({ event: "exchange", client: id, actor: actor.client_id, scope: claims.scope });
    return send(res, 200, { access_token: await sign(claims, exp), expires_in: exp - now(), token_type: "Bearer", issued_token_type: "urn:ietf:params:oauth:token-type:access_token" });
  }
  return send(res, 400, { error: "unsupported_grant_type" });
}

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/.well-known/jwks.json") return send(res, 200, { keys: [jwk] });
    if (req.method === "POST" && req.url === "/oauth2/token") return await token(req, res);
    // マネージドログインの代わり。利用者のトークンを直接出す。ローカルの検証でだけ使う
    if (req.method === "POST" && req.url === "/test/login") {
      const { sub, scope } = JSON.parse(await read(req)) as { sub: string; scope: string };
      return send(res, 200, { access_token: await sign({ sub, client_id: USER_CLIENT, scope }, now() + 3600) });
    }
    send(res, 404, { error: "not_found" });
  } catch (e) {
    log({ event: "error", error: String(e) });
    send(res, 500, { error: "server_error" });
  }
}).listen(9000, () => log({ event: "listening", port: 9000 }));
