import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createProxy, parseRoutes, staticResolver } from "../src/proxy.ts";
import { collectorSender, createTracer, type ExportedSpan } from "../src/trace.ts";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
async function listen(s: ReturnType<typeof createServer>): Promise<number> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}

describe("入口のトレース", () => {
  async function through(tracer: ReturnType<typeof createTracer> | undefined, sent: IncomingHttpHeaders[]) {
    const up = await listen(createServer((req, res) => {
      sent.push(req.headers);
      res.end("ok");
    }));
    const handle = createProxy({ routes: parseRoutes("/=a"), resolver: staticResolver(`a=127.0.0.1:${up}`), timeoutMs: 1_000, maxBodyBytes: 1_000, maxAttempts: 1, log: () => {}, ...(tracer ? { tracer } : {}) });
    const front = await listen(createServer((req, res) => void handle(req, res)));
    const viewer = `00-${"ee".repeat(16)}-${"ee".repeat(8)}-01`;
    await (await fetch(`http://127.0.0.1:${front}/cb?code=secret`, { headers: { traceparent: viewer, tracestate: "x=1" } })).text();
    return viewer;
  }
  it("閲覧者の traceparent を捨て、自分のスパンを渡し、クエリは残さない", async () => {
    const spans: ExportedSpan[] = [];
    const sent: IncomingHttpHeaders[] = [];
    const viewer = await through(createTracer((s) => spans.push(...s)), sent);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent[0]?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(sent[0]?.traceparent).not.toBe(viewer);
    expect(sent[0]?.tracestate).toBeUndefined();
    const client = spans.find((s) => s.kind === 3)!;
    const root = spans.find((s) => s.kind === 2)!;
    expect(sent[0]?.traceparent).toBe(`00-${root.traceId}-${client.spanId}-01`);
    expect(client.parentSpanId).toBe(root.spanId);
    expect(root.attrs["http.response.status_code"]).toBe(200);
    expect(JSON.stringify(spans)).not.toContain("secret");
  });
  it("トレースしなくても、閲覧者の traceparent は捨てる", async () => {
    const sent: IncomingHttpHeaders[] = [];
    await through(undefined, sent);
    expect(sent[0]?.traceparent).toBeUndefined();
  });
  it("collector へ送る。いなければ捨てる", async () => {
    const got: string[] = [];
    const port = await listen(createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d)).on("end", () => {
        got.push(`${req.url} ${b}`);
        res.end("{}");
      });
    }));
    const span: ExportedSpan = { traceId: "ab".repeat(16), spanId: "cd".repeat(8), name: "GET a", kind: 2, startMs: 1, endMs: 2, attrs: { "url.path": "/" }, failed: false };
    collectorSender("c", staticResolver(`c=127.0.0.1:${port}`))([span]);
    collectorSender("none", staticResolver(`c=127.0.0.1:${port}`))([span]);
    collectorSender("c", staticResolver("c=127.0.0.1:1"))([span]);
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toHaveLength(1);
    expect(got[0]).toContain("/v1/traces");
    expect(got[0]).toContain('"service.name"');
  });
});
