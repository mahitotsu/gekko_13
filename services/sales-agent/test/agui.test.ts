import { describe, expect, it } from "vitest";
import { memoryState, useState } from "../../../packages/state/src/index.ts";
import { handleRun } from "../src/agui.ts";
import { Hono } from "hono";
import type { Thread } from "../src/thread.ts";

// AG-UI の受け口（段 D の D1-a3。判断 55）。会話は置き場所から読み、区切りまで進めて書き戻す。回ごとに別のタスクが受けてもよい。

/** 1 つ目の回で質問し、2 つ目の回の答えで番を終える、小さなエンジン。 */
const engine = async (t: Thread, input: { text: string } | { answer: string }) => {
  if ("text" in input) return t.frontend("ask_customer", { question: "受け取り方は", options: ["a", "b"] });
  t.say(`答え: ${input.answer}`);
};

function app() {
  const a = new Hono();
  a.post("/agui", (c) => handleRun(c, engine));
  return a;
}

const run = (threadId: string, messages: object[], sub = "alice") =>
  app().request(
    "/agui",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, runId: crypto.randomUUID(), state: {}, messages, tools: [], context: [], forwardedProps: {} }) },
    { incoming: { verified: { token: "a-token", claims: { sub } } } },
  );

const events = async (res: Response) =>
  (await res.text())
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.replace(/^data: /, "")) as Record<string, any>);

describe("AG-UI の受け口", () => {
  it("2 つ目の回は、置き場所の会話から続ける（1 つ目の回を受けたタスクでなくてもよい）", async () => {
    useState(memoryState());
    const first = await events(await run("th-a", [{ id: "u1", role: "user", content: "相談したい" }]));
    const call = first.find((e) => e.type === "TOOL_CALL_START")!;
    expect(first.at(-1)?.type).toBe("RUN_FINISHED");
    const second = await events(await run("th-a", [{ id: "t1", role: "tool", toolCallId: call.toolCallId, content: "a" }]));
    expect(second.find((e) => e.type === "TEXT_MESSAGE_CONTENT")?.delta).toBe("答え: a");
    expect(second.at(-1)?.type).toBe("RUN_FINISHED");
  });

  it("待っている道具でない答えは、409 で断り、会話を変えない", async () => {
    useState(memoryState());
    const first = await events(await run("th-b", [{ id: "u1", role: "user", content: "相談したい" }]));
    const call = first.find((e) => e.type === "TOOL_CALL_START")!;
    expect((await run("th-b", [{ id: "t1", role: "tool", toolCallId: "other", content: "a" }])).status).toBe(409);
    const again = await events(await run("th-b", [{ id: "t2", role: "tool", toolCallId: call.toolCallId, content: "b" }]));
    expect(again.find((e) => e.type === "TEXT_MESSAGE_CONTENT")?.delta).toBe("答え: b");
  });

  it("ヘッダーと RUN_STARTED を先に返し、回の間に SSE のコメントを流しても、AG-UI のイベントとして読める", async () => {
    useState(memoryState());
    const res = await run("th-d", [{ id: "u1", role: "user", content: "相談したい" }]);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const first = await events(res);
    expect(first[0]?.type).toBe("RUN_STARTED");
    expect(first.at(-1)?.type).toBe("RUN_FINISHED");
  });

  it("ほかの顧客の会話は、続けさせない", async () => {
    useState(memoryState());
    // ヘッダーは回を進める前に返るので、本文を読み切って、1 つ目の回が会話を書き戻すのを待つ
    await events(await run("th-c", [{ id: "u1", role: "user", content: "相談したい" }]));
    expect((await run("th-c", [{ id: "u2", role: "user", content: "横から" }], "mallory")).status).toBe(403);
  });
});
