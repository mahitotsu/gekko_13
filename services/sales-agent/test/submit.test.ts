import { describe, expect, it } from "vitest";
import type { ToolResult } from "../src/mcp.ts";
import { submitSigned } from "../src/submit.ts";
import { newThreadData, Thread } from "../src/thread.ts";

// 提出の送り直し（段 D の D1-a3）。保険会社のシステムに届かなかったら、同じ書類で送り直す。保険会社のシステムは、同じ申込みの 2 度目を重ねない
const signedThread = () => {
  const t = new Thread(newThreadData("th-submit", "alice"));
  t.signed = { intent: { nonce: "n-1" }, intentAssertion: { a: 1 }, application: { nonce: "n-1" }, assertion: { a: 2 } } as never;
  return t;
};
const noWait = async () => {};
const seq = (results: (ToolResult | Error)[]) => {
  const sent: unknown[] = [];
  const call = async (_ctx: string, _name: string, args?: Record<string, unknown>) => {
    sent.push(args?.application);
    const r = results.shift()!;
    if (r instanceof Error) throw r;
    return r;
  };
  return { call, sent };
};

describe("提出の送り直し", () => {
  it("届かなければ同じ書類で送り直し、前の提出が受け付け済みなら、その契約で終える", async () => {
    const t = signedThread();
    const { call, sent } = seq([
      { isError: false, body: { status: 503, error: "届かなかった", retryable: true } },
      { isError: false, body: { status: 409, error: "この申込みは受け付け済み", alreadyAccepted: true, contract: { contractId: "C-1" } } },
    ]);
    const r = await submitSigned(t, call as never, noWait);
    expect(r).toEqual({ isError: false, body: { ok: true, contract: { contractId: "C-1" }, alreadyAccepted: true } });
    expect(sent).toEqual([{ nonce: "n-1" }, { nonce: "n-1" }]);
    expect(t.signed).toEqual({});
  });

  it("送り直しても届かなければ、書類を残す（顧客が、同じ申込みをもう一度送れる）", async () => {
    const t = signedThread();
    const down = { isError: false, body: { status: 503, error: "届かなかった", retryable: true } };
    const { call, sent } = seq([down, new Error("socket hang up"), down]);
    const r = await submitSigned(t, call as never, noWait);
    expect(r.body.retryable).toBe(true);
    expect(sent).toHaveLength(3);
    expect(t.signed.application).toEqual({ nonce: "n-1" });
  });

  it("断られたら（送り直してよい失敗でない）、送り直さず、書類を消す", async () => {
    const t = signedThread();
    const { call, sent } = seq([{ isError: false, body: { status: 403, error: "申込みの署名の照合" } }]);
    await submitSigned(t, call as never, noWait);
    expect(sent).toHaveLength(1);
    expect(t.signed).toEqual({});
  });
});
