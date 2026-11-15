// 入口のサービス。利用者のトークンを受け、BFF として交換して transfer を mTLS で呼ぶ。
// 入口（利用者からの受け口）は、後で CloudFront の後ろに置く。この検証では平文の HTTP にする（計画の「後回し」）。
import { createServer } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { actorTokenSource, exchange } from "../../../packages/token-check/src/index.ts";
import { json, mtlsCall, readBody, SvidSource } from "../../../packages/spiffe-tls/src/index.ts";
import { env, log } from "../../_shared/src/env.ts";

const svid = new SvidSource(env("SVID_DIR"));
const me = await svid.start();
log({ event: "svid_loaded", id: me.id, serial: me.serial, notAfter: me.notAfter });
svid.onChange((s) => log({ event: "svid_rotated", id: s.id, serial: s.serial, notAfter: s.notAfter }));

const ISSUER = env("ISSUER");
const USER_CLIENT = env("USER_CLIENT_ID");
const jwks = createRemoteJWKSet(new URL(env("JWKS_URL")));
const SCOPE = "banking/transfer";
const client = { tokenUrl: env("TOKEN_URL"), clientId: env("CLIENT_ID"), clientSecret: env("CLIENT_SECRET") };
const actorToken = actorTokenSource({ ...client, scope: env("ACTOR_SCOPE") });
const NEXT_URL = env("NEXT_URL");
const NEXT_ID = env("NEXT_ID");

createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/transfer") return json(res, 404, { error: "not_found" });
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    if (!m) return json(res, 401, { error: "no_token" });
    try {
      const { payload } = await jwtVerify(m[1], jwks, { issuer: ISSUER });
      if (payload.token_use !== "access" || payload.client_id !== USER_CLIENT) throw new Error("not user token");
    } catch {
      return json(res, 401, { error: "invalid_token" });
    }
    const body = await readBody(req);
    const token = await exchange({ ...client, subjectToken: m[1], actorToken: await actorToken(), scope: SCOPE });
    const r = await mtlsCall(svid.current, `${NEXT_URL}/transfer`, NEXT_ID, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
    log({ event: "forwarded", status: r.status });
    res.writeHead(r.status, { "content-type": "application/json" }).end(r.body);
  } catch (e) {
    log({ event: "error", error: String(e) });
    if (!res.headersSent) json(res, 502, { error: "upstream", detail: String(e) });
  }
}).listen(8080, () => log({ event: "listening", port: 8080 }));
