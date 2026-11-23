import { describe, expect, it } from "vitest";
import { isRetryable } from "../src/index.ts";

// 応答が届く前につなぎが切れたときだけ、送り直す（段 D の D1-a3）
describe("送り直してよい誤り", () => {
  const err = (code: string | undefined, message: string) => Object.assign(new Error(message), { code });

  it("つなぎが切れた、拒まれた、握手の前に切れたときは、送り直す", () => {
    expect(isRetryable(err("ECONNRESET", "read ECONNRESET"))).toBe(true);
    expect(isRetryable(err("ECONNREFUSED", "connect ECONNREFUSED"))).toBe(true);
    expect(isRetryable(err(undefined, "Client network socket disconnected before secure TLS connection was established"))).toBe(true);
  });

  it("相手の SPIFFE ID が違う、時間切れ、取りやめは、送り直さない", () => {
    expect(isRetryable(new Error("相手の SPIFFE ID が違う: spiffe://x/svc/y"))).toBe(false);
    expect(isRetryable(new Error("timeout"))).toBe(false);
    expect(isRetryable(new Error("aborted"))).toBe(false);
  });
});
