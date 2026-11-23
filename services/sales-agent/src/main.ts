// 営業 AI エージェントを起動する（段 D の D1-a2-2）。受け口は SVID の mTLS（既定 8443）で、呼べるのは顧客のアプリの BFF だけ（gekko_11 の D-41）。
// BFF は、トークン A と DPoP の proof を付けて呼ぶ。token-guard で、相手、A（ログインサーバーの公開鍵）、DPoP を確かめてから、AG-UI に渡す。
// DPoP の htu は、BFF が呼ぶ名前（PUBLIC_ORIGIN、既定 https://sales-agent:8443）とパスで照らす。
// 会話は、共有のデータベースに置く。DB_URL と STATE_KEY がなければ、起動しない（段 D の D1-a3）。
import type { IncomingMessage } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createRemoteJWKSet } from "jose";
import { createMtlsServer, peerX5tS256, SvidSource } from "../../../packages/spiffe-tls/src/index.ts";
import { createGuard, Refusal } from "../../../packages/token-guard/src/index.ts";
import { createApp } from "./app.ts";
import type { Verified } from "./claims.ts";
import { useSvids } from "./mcp.ts";
import { pgState, useState } from "../../../packages/state/src/index.ts";

const log = (o: object) => console.log(JSON.stringify({ at: new Date().toISOString(), svc: "sales-agent", ...o }));
const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`環境変数 ${name} がない`);
  return v;
};

const td = env("TRUST_DOMAIN", "gekko13.internal");
const issuer = env("LOGIN_ISSUER");
// ログインサーバーの公開鍵は、ログインサーバーへ送る先（AWS では公開の名前で、TLS で確かめる。手元ではコンテナの名前）から取る
const loginOrigin = env("LOGIN_ORIGIN", new URL(issuer).origin);
const jwksUrl = new URL(`${new URL(issuer).pathname}/protocol/openid-connect/certs`, loginOrigin);
const publicOrigin = env("PUBLIC_ORIGIN", "https://sales-agent:8443");

const guard = createGuard({
  service: "sales-agent",
  issuer,
  keys: createRemoteJWKSet(jwksUrl, { cooldownDuration: 30_000 }),
  ingress: "dpop",
  allowedCallers: [`spiffe://${td}/svc/customer-app`],
});

const svids = new SvidSource(env("SVID_DIR", "/svid"));
const first = await svids.start();
log({ ev: "svid", id: first.id, notAfter: first.notAfter, engine: "scripted" });
useSvids(svids);
// 会話は、共有のデータベースに置く（段 D の D1-a3。判断 55）。会話には、顧客が署名した書類が入るので、暗号化して置く
useState(await pgState());
log({ ev: "state", store: "postgres" });

const listener = getRequestListener(createApp().fetch);
const port = Number(env("APP_PORT", "8443"));
createMtlsServer(
  svids,
  async (req, res, peerId) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const r = await guard(
        { method: req.method ?? "GET", url: `${publicOrigin}${path}`, authorization: req.headers.authorization, dpop: req.headers.dpop as string | undefined },
        { spiffeId: peerId, x5tS256: peerX5tS256(req) },
      );
      (req as IncomingMessage & { verified?: Verified }).verified = { token: r.token, claims: r.claims };
    } catch (e) {
      const status = e instanceof Refusal ? e.status : 403;
      log({ ev: "refused", reason: e instanceof Refusal ? e.reason : "error", error: (e as Error).message });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      return;
    }
    await listener(req, res);
  },
  log,
).listen(port, "0.0.0.0", () => log({ ev: "listening", port, mtls: true }));
