// 入口の中継（段 D の D0-b）を起こす。Web Functions は、環境変数 AWS_LAMBDA_HTTP_ENDPOINT（host:port）で待ち受けさせる。
// - ROUTES: 振り分け。例 "/login=keycloak,/=edge-check"
// - NAMESPACE: 送り先の SRV を引く名前空間。例 "svc.gekko13.internal"
// - STATIC_TARGETS: ローカルの確かめ用。あれば SRV を引かずに、この送り先へ送る。例 "keycloak=127.0.0.1:8180,edge-check=127.0.0.1:8080"
import { createServer } from "node:http";
import { createProxy, parseRoutes, srvResolver, staticResolver } from "./proxy.ts";

const log = (o: object) => console.log(JSON.stringify({ at: new Date().toISOString(), svc: "entry", ...o }));

const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "127.0.0.1:3000";
const i = endpoint.lastIndexOf(":");
const host = endpoint.slice(0, i);
const port = Number(endpoint.slice(i + 1));

const routes = parseRoutes(process.env.ROUTES ?? "/login=keycloak,/=edge-check");
const resolver = process.env.STATIC_TARGETS
  ? staticResolver(process.env.STATIC_TARGETS)
  : srvResolver(process.env.NAMESPACE ?? "svc.gekko13.internal", Number(process.env.SRV_CACHE_MS ?? 10_000));

const handle = createProxy({
  routes,
  resolver,
  timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 25_000),
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 6 * 1024 * 1024),
  maxAttempts: 3,
  log,
});

createServer((req, res) => {
  handle(req, res).catch((e) => {
    log({ ev: "error", error: String(e) });
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" }).end("internal error");
    else res.destroy();
  });
}).listen(port, host, () => log({ ev: "listening", endpoint, routes }));
