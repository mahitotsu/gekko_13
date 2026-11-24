import { describe, expect, it } from "vitest";
import { warmKeys } from "../src/index.ts";

describe("鍵を起動時に取る", () => {
  it("取れるまで、間を延ばして取り直す", async () => {
    let calls = 0;
    const logs: Record<string, unknown>[] = [];
    await warmKeys(
      async () => {
        if (++calls < 3) throw new Error("つながらない");
      },
      (o) => logs.push(o as Record<string, unknown>),
      40,
      10,
    );
    expect(calls).toBe(3);
    expect(logs.map((l) => l.ev)).toEqual(["keys_retry", "keys_retry", "keys_ready"]);
    expect(logs.map((l) => l.inMs).slice(0, 2)).toEqual([10, 20]);
  });
});
