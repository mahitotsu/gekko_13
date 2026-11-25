// 計装を読んだ別のプロセスで、ESM の名前つきの import の node:https に traceparent が付き、スパンが送られることを確かめる。
// packages/spiffe-tls の mtlsFetch が、この形で呼ぶ。collector がなくても、呼び出しは通る。
import { execFile } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const register = new URL("../src/register.ts", import.meta.url).pathname;
const seen: IncomingHttpHeaders[] = [];
let traces = 0;
const server = createServer((req, res) => {
  if (req.url === "/v1/traces") traces++;
  else seen.push(req.headers);
  req.resume().on("end", () => res.end("{}"));
});
let origin = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());

/** 子のプロセスで、名前つきの import の request を 1 回呼ぶ。送り終えるのを少し待つ。 */
const child = (endpoint: string | undefined, wait: number) =>
  run(
    process.execPath,
    ["--import", register, "--input-type=module", "-e",
      `import { request } from "node:http"; await new Promise((ok, ng) => request("${origin}/x", (r) => r.resume().on("end", ok)).on("error", ng).end()); await new Promise((r) => setTimeout(r, ${wait}));`],
    { env: { PATH: process.env.PATH, SERVICE: "t", ...(endpoint ? { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint } : {}) } },
  );

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
  it("collector に届かなくても、呼び出しは通る", async () => {
    seen.length = 0;
    await child("http://127.0.0.1:1", 0);
    expect(seen).toHaveLength(1);
  });
});
