// 中間のサービス。BFF から、BFF として交換したトークンで呼ばれたら、transfer として交換し直して ledger を呼ぶ。
import { actorTokenSource, createVerifier, exchange } from "../../../packages/token-check/src/index.ts";
import { createMtlsServer, json, mtlsCall, readBody, SvidSource } from "../../../packages/spiffe-tls/src/index.ts";
import { env, log } from "../../_shared/src/env.ts";

const svid = new SvidSource(env("SVID_DIR"));
const me = await svid.start();
log({ event: "svid_loaded", id: me.id, serial: me.serial, notAfter: me.notAfter });

const SCOPE = "banking/transfer";
const verify = createVerifier({ issuer: env("ISSUER"), callers: JSON.parse(env("CALLERS")), requiredScope: SCOPE }, env("JWKS_URL"));
const client = { tokenUrl: env("TOKEN_URL"), clientId: env("CLIENT_ID"), clientSecret: env("CLIENT_SECRET") };
const actorToken = actorTokenSource({ ...client, scope: env("ACTOR_SCOPE") });
const NEXT_URL = env("NEXT_URL");
const NEXT_ID = env("NEXT_ID");

createMtlsServer(
  svid,
  async (req, res, peerId) => {
    if (req.method !== "POST" || req.url !== "/transfer") return json(res, 404, { error: "not_found" });
    const v = await verify(req.headers.authorization, peerId);
    if (!v.ok) {
      log({ event: "denied", peer: peerId, reason: v.reason });
      return json(res, v.status, { error: v.reason, service: "transfer" });
    }
    const body = await readBody(req);
    const subjectToken = req.headers.authorization!.slice("Bearer ".length);
    const token = await exchange({ ...client, subjectToken, actorToken: await actorToken(), scope: SCOPE });
    const r = await mtlsCall(svid.current, `${NEXT_URL}/entries`, NEXT_ID, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
    log({ event: "forwarded", peer: peerId, sub: v.claims.sub, status: r.status });
    res.writeHead(r.status, { "content-type": "application/json" }).end(r.body);
  },
  log,
).listen(8443, () => log({ event: "listening", port: 8443 }));
