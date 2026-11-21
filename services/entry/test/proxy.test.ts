import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createProxy, forwardHeaders, parseRoutes, publicForwardHeaders, routeFor, srvResolver, staticResolver, type Resolver } from "../src/proxy.ts";

describe("振り分け", () => {
  const routes = parseRoutes("/=edge-check,/login=keycloak");
  it("区切りの単位で、長い接頭辞を先に比べる", () => {
    expect(routeFor(routes, "/login")).toBe("keycloak");
    expect(routeFor(routes, "/login/realms/x")).toBe("keycloak");
    expect(routeFor(routes, "/loginx")).toBe("edge-check");
    expect(routeFor(routes, "/")).toBe("edge-check");
  });
  it("/ がなければ、合わないパスは送り先なし", () => {
    expect(routeFor(parseRoutes("/login=keycloak"), "/app")).toBeUndefined();
  });
  it("読めない指定は拒む", () => {
    expect(() => parseRoutes("login=keycloak")).toThrow();
    expect(() => parseRoutes("")).toThrow();
  });
});

describe("ヘッダー", () => {
  it("hop-by-hop と、Connection に名前のあるヘッダーを除く", () => {
    const out = forwardHeaders({ connection: "keep-alive, x-drop", "keep-alive": "5", "x-drop": "1", "x-keep": "2", "transfer-encoding": "chunked", cookie: "a=1" });
    expect(out).toEqual({ "x-keep": "2", cookie: "a=1" });
  });
});

describe("SRV の解決", () => {
  it("TTL の間は引き直さず、失敗を知らされたら引き直す", async () => {
    let calls = 0;
    const r = srvResolver("svc.test", 60_000, async (name) => {
      calls++;
      expect(name).toBe("edge-check.svc.test");
      return [{ name: "a.edge-check.svc.test", port: 32768 }];
    });
    expect(await r.resolve("edge-check")).toEqual([{ host: "a.edge-check.svc.test", port: 32768 }]);
    await r.resolve("edge-check");
    expect(calls).toBe(1);
    r.failed("edge-check");
    await r.resolve("edge-check");
    expect(calls).toBe(2);
  });
  it("登録がないときは空にする", async () => {
    const r = srvResolver("svc.test", 0, async () => {
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    });
    expect(await r.resolve("keycloak")).toEqual([]);
  });
});

// 偽の送り先とリバースプロキシを立てて、リクエストを通す
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
async function listen(s: Server): Promise<number> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}
function upstream(name: string) {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    if (req.url === "/redirect") return res.writeHead(302, { location: "https://example.test/next" }).end();
    res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/login"]);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ name, method: req.method, url: req.url, sha256: createHash("sha256").update(body).digest("hex"), host: req.headers.host, xff: req.headers["x-forwarded-for"] }),
    );
  });
}
async function proxyWith(resolver: Resolver) {
  const handle = createProxy({ routes: parseRoutes("/login=keycloak,/=edge-check"), resolver, timeoutMs: 5_000, maxBodyBytes: 1024, maxAttempts: 3, log: () => {} });
  return listen(createServer((req, res) => void handle(req, res)));
}

describe("中継", () => {
  it("パスで送り先を選び、本文、クエリ、Host（fetch が中継の名前を入れる）、複数の Set-Cookie をそのまま通す", async () => {
    const kc = await listen(upstream("keycloak"));
    const ec = await listen(upstream("edge-check"));
    const p = await proxyWith(staticResolver(`keycloak=127.0.0.1:${kc},edge-check=127.0.0.1:${ec}`));
    const body = "username=alice&password=%E3%81%82";
    const r = await fetch(`http://127.0.0.1:${p}/login/realms/x?a=1&b=%20`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.7" },
      body,
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, string>;
    expect(j).toMatchObject({ name: "keycloak", method: "POST", url: "/login/realms/x?a=1&b=%20", host: `127.0.0.1:${p}`, xff: "198.51.100.7" });
    expect(j.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(r.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/login"]);
    const g = (await (await fetch(`http://127.0.0.1:${p}/edge-point`)).json()) as Record<string, string>;
    expect(g.name).toBe("edge-check");
  });

  it("リダイレクトをたどらずに返す", async () => {
    const ec = await listen(upstream("edge-check"));
    const p = await proxyWith(staticResolver(`edge-check=127.0.0.1:${ec}`));
    const r = await fetch(`http://127.0.0.1:${p}/redirect`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://example.test/next");
  });

  it("つながらない送り先を飛ばし、生きている送り先へ POST を送り直す", async () => {
    const dead = await listen(createServer());
    servers.pop()?.close(); // 閉じたポート（つながらない）
    const ec = await listen(upstream("edge-check"));
    let failed = 0;
    const resolver: Resolver = {
      resolve: async () => [{ host: "127.0.0.1", port: dead }, { host: "127.0.0.1", port: ec }],
      failed: () => void failed++,
    };
    const handle = createProxy({ routes: parseRoutes("/=edge-check"), resolver, timeoutMs: 5_000, maxBodyBytes: 1024, maxAttempts: 3, log: () => {}, random: () => 0.99 });
    const p = await listen(createServer((req, res) => void handle(req, res)));
    const r = await fetch(`http://127.0.0.1:${p}/x`, { method: "POST", body: "hello" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as Record<string, string>).sha256).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(failed).toBe(1);
  });

  it("送り先がなければ 503、本文が上限を超えれば 413", async () => {
    const p = await proxyWith(staticResolver(""));
    expect((await fetch(`http://127.0.0.1:${p}/`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${p}/`, { method: "POST", body: "x".repeat(2048) })).status).toBe(413);
  });
});

describe("公開の origin の転送のヘッダー", () => {
  it("閲覧者の転送のヘッダーを捨て、公開の origin から付け直す", () => {
    const out = publicForwardHeaders({ "x-forwarded-host": "evil.example", forwarded: "host=evil", "x-forwarded-for": "198.51.100.7", cookie: "a=1" }, "https://d1.cloudfront.net");
    expect(out).toEqual({ "x-forwarded-for": "198.51.100.7", cookie: "a=1", "x-forwarded-proto": "https", "x-forwarded-host": "d1.cloudfront.net", "x-forwarded-port": "443" });
  });
  it("公開の origin がなければ、転送のヘッダーを付けない（閲覧者のものも捨てる）", () => {
    expect(publicForwardHeaders({ "x-forwarded-proto": "http", accept: "*/*" }, undefined)).toEqual({ accept: "*/*" });
    expect(publicForwardHeaders({}, "http://gekko13.localhost:18000")).toMatchObject({ "x-forwarded-proto": "http", "x-forwarded-host": "gekko13.localhost:18000", "x-forwarded-port": "18000" });
  });
});
