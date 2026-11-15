// 最も奥のサービス。transfer から、transfer として交換したトークンで呼ばれたときだけ記帳する。
import { createVerifier } from "../../../packages/token-check/src/index.ts";
import { createMtlsServer, json, readBody, SvidSource } from "../../../packages/spiffe-tls/src/index.ts";
import { env, log } from "../../_shared/src/env.ts";

const svid = new SvidSource(env("SVID_DIR"));
const me = await svid.start();
log({ event: "svid_loaded", id: me.id, serial: me.serial, notAfter: me.notAfter });

const verify = createVerifier(
  { issuer: env("ISSUER"), callers: JSON.parse(env("CALLERS")), requiredScope: "banking/transfer" },
  env("JWKS_URL"),
);

createMtlsServer(
  svid,
  async (req, res, peerId) => {
    if (req.method !== "POST" || req.url !== "/entries") return json(res, 404, { error: "not_found" });
    const v = await verify(req.headers.authorization, peerId);
    if (!v.ok) {
      log({ event: "denied", peer: peerId, reason: v.reason });
      return json(res, v.status, { error: v.reason, service: "ledger" });
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    log({ event: "recorded", peer: peerId, sub: v.claims.sub, caller: v.caller, origin_jti: v.claims.origin_jti });
    json(res, 200, { recorded: true, sub: v.claims.sub, caller: v.caller, peer: peerId, entry: body, served_by: svid.current.serial });
  },
  log,
).listen(8443, () => log({ event: "listening", port: 8443 }));
