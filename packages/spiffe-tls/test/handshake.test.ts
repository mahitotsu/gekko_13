import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { mtlsFetch, type SvidSource } from "../src/index.ts";

describe("握手の待ち（段 D の D1-a3）", () => {
  it("TCP はつながるが握手で黙る相手は、握手の待ちで見切って送り直し、段と経過をログに出す", async () => {
    // 止まったタスクへ向かった Service Connect の中継と同じ見え方: つながるが、TLS の握手に何も返さない
    const sockets: Socket[] = [];
    const server = createServer((s) => void sockets.push(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const source = { current: { cert: "", key: "", bundle: "" } } as unknown as SvidSource;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const started = Date.now();
    const err = await mtlsFetch(source, "spiffe://t/svc/x", 5_000, 2, 200)(`https://127.0.0.1:${port}/x`).catch((e: unknown) => e);
    spy.mockRestore();
    for (const s of sockets) s.destroy();
    server.close();
    expect((err as NodeJS.ErrnoException).code).toBe("EHANDSHAKETIMEOUT");
    expect(Date.now() - started).toBeLessThan(2_000);
    const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.ev === "call_retry");
    expect(lines.map((l) => [l.attempt, l.phase, l.retried])).toEqual([
      [1, "handshake", true],
      [2, "handshake", false],
    ]);
  });
});
