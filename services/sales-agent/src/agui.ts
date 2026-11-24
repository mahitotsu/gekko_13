// AG-UI の受け口（gekko_11 の D-29）。AG-UI 1.0 の HTTP と SSE: POST で RunAgentInput を受け、SSE で 1 回分のイベントを返す。
// 回は、営業 AI エージェントが画面側の道具を呼んだところ（顧客の答えを待つ）か、番が終わったところで閉じる。
// 顧客の答えは、次の回の tool message で届く。トークンは token-guard が確かめ（gekko_11 の G20）、会話は本人（sub）に結び付ける。
// 会話は共有のデータベースに置き、回ごとに、行をロックして読み、区切りまで進め、書き戻してから、イベントを流す（段 D の D1-a3。判断 55）。
// 書き戻す前に流すと、画面が次の答えを送ったときに、別のタスクが古い会話を読みうるためである。ヘッダーと RUN_STARTED だけは、先に返す。
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
/** 回を進めている間、SSE のコメントを流す間隔。入口の待ちの上限（UPSTREAM_TIMEOUT_MS、25 秒）より十分短くする。 */
const KEEPALIVE_MS = 5_000;

/**
 * 手元の確かめだけで使う切り方（段 D の D1-a3。AWS のタスク定義には付けない）。1 にすると、回を進めて書き戻したあと、
 * 各 runId の 1 回目だけ、イベントを半分流したところでつなぎを切る。画面が同じ runId で送り直し、流し直しで続くかを見る。
 */
const CUT_STREAM = process.env.GEKKO13_FAULT_CUT_STREAM === "1";
const cut = new Set<string>();

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

  /** 会話の中身を確かめ、受けられない回なら断る。ヘッダーを返す前に、ロックなしで 1 度、ロックの中でもう 1 度呼ぶ。 */
  const check = (raw: string | undefined): ThreadData => {
    const data = raw ? (JSON.parse(raw) as ThreadData) : newThreadData(input.threadId, sub);
    if (data.sub !== sub) throw new Refused(403, "この会話は、ほかの顧客のものである");
    const waiting = data.pending?.id;
    if (waiting && !input.messages.some((m) => m.role === "tool" && m.toolCallId === waiting)) {
      throw new Refused(409, `道具の呼び出し ${waiting} への答え（tool message）がない`);
    }
    if (!waiting && !input.messages.some((m) => m.role === "user")) throw new Refused(400, "顧客の文（user message）がない");
    return data;
  };
  /** 同じ runId の送り直しなら、その回で流したイベント。本人の会話であることは、先に確かめる。 */
  const replayOf = (raw: string | undefined): Item[] | undefined => {
    if (!raw) return undefined;
    const data = JSON.parse(raw) as ThreadData;
    if (data.sub !== sub) throw new Refused(403, "この会話は、ほかの顧客のものである");
    return data.lastRun?.runId === input.runId ? data.lastRun.items : undefined;
  };
  let replay: Item[] | undefined;
  try {
    const raw = await state().get("conversation", input.threadId);
    replay = replayOf(raw);
    if (!replay) check(raw);
  } catch (e) {
    if (e instanceof Refused) return c.json({ error: e.message }, e.status);
    throw e;
  }

  // ヘッダーと RUN_STARTED は、回を進める前に返す。回の中で、ほかのサービスの呼び出しが待たされても、入口と BFF が見切らないように、
  // 進めている間は SSE のコメントを流す（段 D の D1-a3）。イベントそのものは、会話を書き戻してから流す
  c.header("content-type", "text/event-stream");
  c.header("cache-control", "no-cache");
  return stream(c, async (s) => {
    const base = { threadId: input.threadId, runId: input.runId };
    await s.write(sse({ type: EventType.RUN_STARTED, ...base }));
    const beat = setInterval(() => void s.write(": keep-alive\n\n").catch(() => undefined), KEEPALIVE_MS);
    let items: Item[];
    try {
      items = replay ?? await state().locked("conversation", input.threadId, async (raw) => {
        // ロックを待つ間に、同じ runId の送り直しが先に進めていたら、その結果を流す（会話は変えない）
        const done = replayOf(raw);
        if (done) return { result: done };
        const t = new Thread(check(raw));
        t.ctx = verified.token;
        t.claims = claims;
        const waiting = t.waitingFor;
        if (waiting) {
          const reply = input.messages.find((m) => m.role === "tool" && m.toolCallId === waiting)!;
          const answer = t.answer(waiting, typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content))!;
          await run(t, engine, { answer });
        } else {
          const said = [...input.messages].reverse().find((m) => m.role === "user")!;
          const text = contentToText(said.content) ?? "";
          t.tell(text);
          await run(t, engine, { text });
        }
        t.data.lastRun = { runId: input.runId, items: t.events() };
        return { value: JSON.stringify(t.data), expiresAt: Date.now() + IDLE_MS, result: t.events() };
      });
    } catch (e) {
      // ロックを待つ間に、ほかのタスクが同じ会話を進めた。会話は変えない
      items = [{ end: true, error: e instanceof Refused ? e.message : `営業 AI エージェントが止まりました: ${(e as Error).message}` }];
    } finally {
      clearInterval(beat);
    }
    const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
    const cutAt = CUT_STREAM && !replay && incoming && !cut.has(input.runId) ? Math.max(1, Math.floor(items.length / 2)) : -1;
    if (cutAt > 0) cut.add(input.runId);
    for (const [i, item] of items.entries()) {
      if (i === cutAt) {
        console.log(JSON.stringify({ at: new Date().toISOString(), svc: "sales-agent", ev: "fault_cut_stream", runId: input.runId, after: i, of: items.length }));
        // 流した分が画面に届いてから切る（すぐ切ると、送っていない分が捨てられ、画面には何も届かない）
        await new Promise((r) => setTimeout(r, 500));
        incoming!.socket.destroy();
        return;
      }
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
