// 計装を読んだ別のプロセスで、ESM の名前つきの import の node:https に traceparent が付き、スパンが送られることを確かめる。
// packages/spiffe-tls の mtlsFetch が、この形で呼ぶ。collector がなくても、呼び出しは通る。
import { execFile } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromLoopback } from "../src/register.ts";

const run = promisify(execFile);
const register = new URL("../src/register.ts", import.meta.url).pathname;
const seen: IncomingHttpHeaders[] = [];
let traces = 0;
const bodies: string[] = [];
const server = createServer((req, res) => {
  if (req.url === "/v1/traces") traces++;
  else seen.push(req.headers);
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c)).on("end", () => {
    if (req.url === "/v1/traces") bodies.push(Buffer.concat(chunks).toString());
    res.end("{}");
  });
});
let origin = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());

/** 子のプロセスで、名前つきの import の request を 1 回呼ぶ。送り終えるのを少し待つ。 */
const child = (endpoint: string | undefined, wait: number, code = `await new Promise((ok, ng) => request("${origin}/x", (r) => r.resume().on("end", ok)).on("error", ng).end());`) =>
  run(
    process.execPath,
    ["--import", register, "--input-type=module", "-e",
      `import { createServer, request } from "node:http"; ${code} await new Promise((r) => setTimeout(r, ${wait}));`],
    { env: { PATH: process.env.PATH, SERVICE: "t", ...(endpoint ? { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint } : {}) } },
  );

/** 送られたスパンの種類（1 内部、2 受けた要求、3 呼んだ要求）。OTLP の JSON から読む。 */
const kinds = () =>
  bodies.flatMap((b) => (JSON.parse(b) as { resourceSpans: { scopeSpans: { spans: { kind: number }[] }[] }[] }).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans.map((x) => x.kind))));

describe("トレースの計装", () => {
  it("送り先があれば、traceparent を付け、スパンを送る", async () => {
    seen.length = 0;
    await child(origin, 3_000);
    expect(seen).toHaveLength(1);
    expect(seen[0].traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(traces).toBeGreaterThan(0);
  });
  it("送り先がなければ、何も付けない", async () => {
    seen.length = 0;
    await child(undefined, 0);
    expect(seen).toHaveLength(1);
    expect(seen[0].traceparent).toBeUndefined();
  });
  it("ループバックから受けた要求（ヘルスチェック）は、スパンにしない", async () => {
    bodies.length = 0;
    // 子のプロセスが自分の 127.0.0.1 の口を呼ぶ。呼んだ側のスパンだけが送られる
    await child(origin, 3_000, `const s = createServer((q, r) => r.end("ok")); await new Promise((r) => s.listen(0, "127.0.0.1", r)); await new Promise((ok, ng) => request("http://127.0.0.1:" + s.address().port + "/config.json", (r) => r.resume().on("end", ok)).on("error", ng).end()); s.close();`);
    expect(kinds()).toContain(3);
    expect(kinds()).not.toContain(2);
  });
  it("ループバックかを、IPv4、IPv6、IPv4 を写した IPv6 で見分ける", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(fromLoopback(a)).toBe(true);
    for (const a of ["172.17.0.5", "::ffff:172.17.0.5", "2001:db8::1", undefined]) expect(fromLoopback(a)).toBe(false);
  });
  it("collector に届かなくても、呼び出しは通る", async () => {
    seen.length = 0;
    await child("http://127.0.0.1:1", 0);
    expect(seen).toHaveLength(1);
  });
});
