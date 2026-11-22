// 入口のリバースプロキシ（段 D の D0-b）。CloudFront から呼ばれる Web Functions の中で動き、パスで送り先のサービスを決め、
// VPC の中のタスクへ、リクエストをそのまま送る。送り先は、名前空間の SRV（ECS がインスタンスの IP と動的なポートで登録する）で見つける。
// - 振り分けは、パスの接頭辞を区切り（/）の単位で比べる。/login は /login と /login/... に合い、/loginx には合わない。
// - 本文は読み切ってから送る。つながる前に失敗したときだけ、別のタスクへリトライする（本文を 2 度届けない）。
// - 応答は、状態とヘッダーと本文を、そのまま返す。hop-by-hop のヘッダーだけを除く。
import { promises as dns } from "node:dns";
import { Agent, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";

export type Route = { prefix: string; service: string };
export type Target = { host: string; port: number };
export interface Resolver {
  resolve(service: string): Promise<Target[]>;
  /** 送れなかった送り先を知らせる。キャッシュを捨てて、次は引き直す。 */
  failed(service: string): void;
}

/** "/login=keycloak,/=customer-app" の形の指定を読む。長い接頭辞から順に比べる。 */
export function parseRoutes(spec: string): Route[] {
  const routes = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [prefix, service] = s.split("=");
      if (!prefix?.startsWith("/") || !service) throw new Error(`振り分けの指定が読めない: ${s}`);
      return { prefix: prefix === "/" ? "/" : prefix.replace(/\/+$/, ""), service };
    });
  if (routes.length === 0) throw new Error("振り分けの指定が空");
  return routes.sort((a, b) => b.prefix.length - a.prefix.length);
}

export function routeFor(routes: Route[], path: string): string | undefined {
  for (const r of routes) {
    if (r.prefix === "/" || path === r.prefix || path.startsWith(`${r.prefix}/`)) return r.service;
  }
  return undefined;
}

/** ローカルの確かめ用。"keycloak=127.0.0.1:8180,customer-app=127.0.0.1:8080" の形で、送り先を固定する。 */
export function staticResolver(spec: string): Resolver {
  const map = new Map<string, Target[]>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [service, addr] = part.split("=");
    const i = addr?.lastIndexOf(":") ?? -1;
    if (!service || !addr || i < 0) throw new Error(`送り先の指定が読めない: ${part}`);
    const list = map.get(service) ?? [];
    list.push({ host: addr.slice(0, i), port: Number(addr.slice(i + 1)) });
    map.set(service, list);
  }
  return { resolve: async (s) => map.get(s) ?? [], failed: () => {} };
}

type SrvLookup = (name: string) => Promise<{ name: string; port: number }[]>;

/** 名前空間の SRV を引く。結果は ttlMs の間だけ持つ（Cloud Map の SRV の TTL にそろえる）。 */
export function srvResolver(namespace: string, ttlMs: number, lookup: SrvLookup = (n) => dns.resolveSrv(n)): Resolver {
  const cache = new Map<string, { at: number; targets: Target[] }>();
  return {
    async resolve(service) {
      const hit = cache.get(service);
      if (hit && Date.now() - hit.at < ttlMs) return hit.targets;
      let targets: Target[] = [];
      try {
        targets = (await lookup(`${service}.${namespace}`)).map((r) => ({ host: r.name, port: r.port }));
      } catch (e) {
        // 登録がない（タスクが 0）ときは ENOTFOUND か ENODATA になる。空として扱う
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOTFOUND" && code !== "ENODATA") throw e;
      }
      cache.set(service, { at: Date.now(), targets });
      return targets;
    },
    failed(service) {
      cache.delete(service);
    },
  };
}

// RFC 9110 の 7.6.1。リバースプロキシが終える接続のヘッダーで、送り先へは渡さない
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

export function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || named.has(k)) continue;
    out[k] = v;
  }
  return out;
}

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

export function shuffle<T>(xs: T[], random = Math.random): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

export type ProxyOptions = {
  routes: Route[];
  resolver: Resolver;
  /** 送り先の応答を待つ上限。Web Functions のリクエストの上限より短くする */
  timeoutMs: number;
  /** 読み切る本文の上限 */
  maxBodyBytes: number;
  /** 1 つのリクエストで試す送り先の数の上限 */
  maxAttempts: number;
  log: (o: object) => void;
  random?: () => number;
  /**
   * 入口の公開の origin（例 "https://dXXXX.cloudfront.net"）。あれば、送り先に X-Forwarded-Proto、Host、Port で渡す。
   * 送り先（Keycloak）は、届いた要求の URL を、これで公開の URL に直す（DPoP の htu の照合。docs/findings.md の 4-34）。
   * 閲覧者が送った同じ名前のヘッダーは、あってもなくても捨てる（偽れないようにする）
   */
  publicOrigin?: string;
};

/** 閲覧者から受け取らない、転送のヘッダー。リバースプロキシが自分で付ける */
const FORWARDED = ["x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "forwarded"];

/** 公開の origin を、転送のヘッダーにする。 */
export function publicForwardHeaders(headers: IncomingHttpHeaders, publicOrigin: string | undefined): IncomingHttpHeaders {
  const out = { ...headers };
  for (const k of FORWARDED) delete out[k];
  if (!publicOrigin) return out;
  const u = new URL(publicOrigin);
  out["x-forwarded-proto"] = u.protocol.replace(":", "");
  out["x-forwarded-host"] = u.host;
  out["x-forwarded-port"] = u.port || (u.protocol === "https:" ? "443" : "80");
  return out;
}

type Attempt = { kind: "response"; res: IncomingMessage } | { kind: "retryable"; error: Error } | { kind: "fatal"; error: Error };

export function createProxy(o: ProxyOptions) {
  const agent = new Agent({ keepAlive: true, timeout: o.timeoutMs });

  function attempt(t: Target, req: IncomingMessage, body: Buffer): Promise<Attempt> {
    return new Promise((resolve) => {
      let connected = false;
      const headers = publicForwardHeaders(forwardHeaders(req.headers), o.publicOrigin);
      if (body.length > 0 || "content-length" in req.headers) headers["content-length"] = String(body.length);
      const up = request({ host: t.host, port: t.port, method: req.method, path: req.url, headers, agent, timeout: o.timeoutMs });
      up.on("socket", (s) => {
        if (!s.connecting) connected = true;
        else s.once("connect", () => (connected = true));
      });
      up.on("response", (res) => resolve({ kind: "response", res }));
      up.on("timeout", () => up.destroy(new Error("送り先が時間内に応えなかった")));
      up.on("error", (error) => {
        // つながる前の失敗と、使い回した接続が切れていた冪等なリクエストは、別のタスクへリトライてよい
        const reused = up.reusedSocket && (error as NodeJS.ErrnoException).code === "ECONNRESET" && IDEMPOTENT.has(req.method ?? "");
        resolve({ kind: !connected || reused ? "retryable" : "fatal", error });
      });
      up.end(body);
    });
  }

  async function readAll(req: IncomingMessage): Promise<Buffer | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > o.maxBodyBytes) return undefined;
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }

  const reply = (res: ServerResponse, status: number, text: string): void => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(text);
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const service = routeFor(o.routes, path);
    if (!service) return reply(res, 404, "not found");
    const body = await readAll(req);
    if (!body) return reply(res, 413, "request body too large");

    let targets: Target[];
    try {
      targets = shuffle(await o.resolver.resolve(service), o.random);
    } catch (e) {
      o.log({ ev: "resolve-failed", service, error: String(e) });
      return reply(res, 503, "no target");
    }
    if (targets.length === 0) {
      o.log({ ev: "no-target", service, path });
      return reply(res, 503, "no target");
    }

    for (const [i, t] of targets.slice(0, o.maxAttempts).entries()) {
      const r = await attempt(t, req, body);
      if (r.kind === "response") {
        res.writeHead(r.res.statusCode ?? 502, forwardHeaders(r.res.headers));
        r.res.pipe(res);
        r.res.on("error", () => res.destroy());
        res.on("close", () => {
          if (!res.writableFinished) r.res.destroy();
        });
        o.log({ ev: "proxied", service, method: req.method, path, status: r.res.statusCode, attempt: i + 1, ms: Date.now() - started });
        return;
      }
      o.log({ ev: "upstream-failed", service, target: `${t.host}:${t.port}`, kind: r.kind, error: r.error.message });
      o.resolver.failed(service);
      if (r.kind === "fatal") return reply(res, 502, "bad gateway");
    }
    return reply(res, 502, "bad gateway");
  };
}
