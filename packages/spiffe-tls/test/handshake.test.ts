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
    const err = await mtlsFetch(source, "spiffe://t/svc/x", 5_000, 2, 200, 0)(`https://127.0.0.1:${port}/x`).catch((e: unknown) => e);
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

  it("握手の前に切られ続けるときは、回数に依らず、合わせて約 10 秒まで送り直す（段 S）", async () => {
    // 起こした直後の Service Connect と同じ見え方: つながるが、握手の前に切られる
    const server = createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const source = { current: { cert: "", key: "", bundle: "" } } as unknown as SvidSource;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const started = Date.now();
    await mtlsFetch(source, "spiffe://t/svc/x", 5_000, 2, 1_000, 2_000)(`https://127.0.0.1:${port}/x`, { method: "POST", body: "x" }).catch((e: unknown) => e);
    spy.mockRestore();
    server.close();
    const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.ev === "call_retry");
    // 回数の上限（2）を超えて、上限の時間（2 秒）まで送り直した。POST でも送り直す。どれも握手の前
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((l) => l.phase === "handshake")).toBe(true);
    expect(lines.at(-1)?.retried).toBe(false);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(1_000);
    expect(elapsed).toBeLessThan(3_000);
  });
});
