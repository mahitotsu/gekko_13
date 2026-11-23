// AG-UI の受け口（gekko_11 の D-29）。AG-UI 1.0 の HTTP と SSE: POST で RunAgentInput を受け、SSE で 1 回分のイベントを返す。
// 回は、営業 AI エージェントが画面側の道具を呼んだところ（顧客の答えを待つ）か、番が終わったところで閉じる。
// 顧客の答えは、次の回の tool message で届く。トークンは token-guard が確かめ（gekko_11 の G20）、会話は本人（sub）に結び付ける。
// 会話は共有のデータベースに置き、回ごとに、行をロックして読み、区切りまで進め、書き戻してから、イベントを流す（段 D の D1-a3。判断 55）。
// 書き戻す前に流すと、画面が次の答えを送ったときに、別のタスクが古い会話を読みうるためである。
import { contentToText, EventType, type BaseEvent } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { IncomingMessage } from "node:http";
import { state } from "../../../packages/state/src/index.ts";
import { claimsOf, encodeClaims, type Verified } from "./claims.ts";
import { newThreadData, Thread, type Item, type ThreadData } from "./thread.ts";

/** SSE の 1 件。data に、AG-UI のイベントを 1 つ、JSON で入れる（AG-UI 1.0 の HTTP と SSE）。 */
const sse = (event: object) => `data: ${JSON.stringify(event)}\n\n`;

/** 会話は、15 分使われなければ捨てる。 */
const IDLE_MS = 15 * 60_000;

/** エンジンの 1 回分。区切りまで進める。 */
export type Engine = (t: Thread, input: { text: string } | { answer: string }) => Promise<void>;

class Refused extends Error {
  readonly status: 400 | 403 | 409;
  constructor(status: 400 | 403 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export async function handleRun(c: Context, engine: Engine) {
  const parsed = RunAgentInputSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "RunAgentInput の形が違う" }, 400);
  const input = parsed.data;
  // 受け口（main.ts）が、token-guard で確かめたトークンと主張を、受けた要求に付ける。ヘッダーでは受け取らない（偽れないように）
  const verified = (c.env as { incoming?: IncomingMessage & { verified?: Verified } } | undefined)?.incoming?.verified;
  if (!verified) return c.json({ error: "確かめたトークンがない" }, 403);
  const claims = encodeClaims(verified.claims);
  const sub = claimsOf(claims).sub;

  let items: Item[];
  try {
    items = await state().locked("conversation", input.threadId, async (raw) => {
      const data = raw ? (JSON.parse(raw) as ThreadData) : newThreadData(input.threadId, sub);
      if (data.sub !== sub) throw new Refused(403, "この会話は、ほかの顧客のものである");
      const t = new Thread(data);
      t.ctx = verified.token;
      t.claims = claims;
      const waiting = t.waitingFor;
      if (waiting) {
        const reply = input.messages.find((m) => m.role === "tool" && m.toolCallId === waiting);
        if (!reply) throw new Refused(409, `道具の呼び出し ${waiting} への答え（tool message）がない`);
        const answer = t.answer(waiting, typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content))!;
        await run(t, engine, { answer });
      } else {
        const said = [...input.messages].reverse().find((m) => m.role === "user");
        if (!said) throw new Refused(400, "顧客の文（user message）がない");
        const text = contentToText(said.content) ?? "";
        t.tell(text);
        await run(t, engine, { text });
      }
      return { value: JSON.stringify(t.data), expiresAt: Date.now() + IDLE_MS, result: t.events() };
    });
  } catch (e) {
    if (e instanceof Refused) return c.json({ error: e.message }, e.status);
    throw e;
  }

  c.header("content-type", "text/event-stream");
  c.header("cache-control", "no-cache");
  return stream(c, async (s) => {
    const base = { threadId: input.threadId, runId: input.runId };
    await s.write(sse({ type: EventType.RUN_STARTED, ...base }));
    for (const item of items) {
      if ("pause" in item) return void (await s.write(sse({ type: EventType.RUN_FINISHED, ...base })));
      if ("end" in item) {
        return void (await s.write(sse(item.error ? { type: EventType.RUN_ERROR, message: item.error } : { type: EventType.RUN_FINISHED, ...base })));
      }
      await s.write(sse(item as BaseEvent));
    }
  });
}

/** エンジンを、区切りまで進める。止まったら、番の終わりにする。区切らずに戻ったら、番の終わりにする。 */
async function run(t: Thread, engine: Engine, input: { text: string } | { answer: string }) {
  try {
    await engine(t, input);
    if (!t.stopped) t.end();
  } catch (e) {
    t.data.pending = undefined;
    t.data.engine = {};
    t.end(`営業 AI エージェントが止まりました: ${(e as Error).message}`);
  }
}
