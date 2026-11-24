// 署名の揃った書類を、事務サービスへ提出する。提出するかは LLM（台本）が決め、運ぶのは、この決まった処理である。
// gekko_11 の vulnerable の乗っ取りの再現（手口 A8）は、写していない。
import { callMcp, type ToolResult } from "./mcp.ts";
import type { Thread } from "./thread.ts";

/** 送り直してよい失敗のときに、送り直す回数（最初の 1 回を含まない）と、最初の間（倍に延ばす）。 */
const RESUBMITS = 2;
const RESUBMIT_WAIT_MS = 1_000;

/**
 * 署名の揃った書類を提出する。事務サービスが「送り直してよい」と返したら（保険会社のシステムに届かなかった）、同じ書類で送り直す。
 * 保険会社のシステムは、同じ署名済みの申込みの 2 度目を重ねず、「受け付け済み」ともうある契約を返すので、契約は 1 つのまま（段 D の D1-a3）。
 * 送り直しても届かなければ、書類を残す（顧客が、同じ申込みをもう一度送れる）。受け付けられたか、断られたら、書類を消す。
 */
export async function submitSigned(t: Thread, call: typeof callMcp = callMcp, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<ToolResult> {
  const { intent, intentAssertion, application, assertion } = t.signed;
  if (!intent || !intentAssertion || !application || !assertion) {
    return { isError: true, body: { error: "意向確認書面と申込書の署名が揃っていない" } };
  }
  const sent = application;
  let r: ToolResult;
  for (let i = 0; ; i++) {
    try {
      r = await call(t.ctx, "submit_application", {
        intent,
        intent_assertion: intentAssertion,
        application: sent,
        assertion,
        offer_jws: t.offer?.offerJws,
      });
    } catch (e) {
      r = { isError: true, body: { error: `事務サービスに届かなかった: ${(e as Error).message}`, retryable: true } };
    }
    // 前の提出が、返事の届く前に受け付けられていた
    if (r.body?.alreadyAccepted && r.body.contract) r = { isError: false, body: { ok: true, contract: r.body.contract, alreadyAccepted: true } };
    if (r.body?.retryable !== true || i >= RESUBMITS) break;
    console.log(JSON.stringify({ at: new Date().toISOString(), svc: "sales-agent", ev: "submit_retry", attempt: i + 1, error: r.body?.error }));
    await wait(RESUBMIT_WAIT_MS * 2 ** i);
  }
  const refused = r.isError || (r.body?.status ?? 0) >= 400 || Boolean(r.body?.error);
  if (r.body?.retryable !== true) t.signed = {};
  t.record("agent_tool", { name: "submit_application", nonce: sent.nonce, status: refused ? "refused" : "ok", contract_id: r.body?.contract?.contractId, error: r.body?.error });
  return r;
}
