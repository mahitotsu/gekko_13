// Claude のエンジンの配線を、偽の query で確かめる（本物の Claude は呼ばない）。
// 画面側の道具の呼び出しで defer して回を区切り、次の回に答えを渡すこと、2 つ目を断ること、失敗したら会話を前のままにすること。
import type { HookCallback, query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeRun, turnStore, type ClaudeState } from "../src/claude.ts";
import { newThreadData, Thread } from "../src/thread.ts";

type Options = { hooks: { PreToolUse: { hooks: HookCallback[] }[] }; sessionStore: { append: (k: unknown, e: unknown[]) => Promise<void> }; resume?: string; prompt?: string };
const pre = (o: Options, name: string, id: string, input: Record<string, unknown>) =>
  o.hooks.PreToolUse[0]!.hooks[0]!({ hook_event_name: "PreToolUse", tool_name: `mcp__agent__${name}`, tool_input: input, tool_use_id: id } as never, id, { signal: new AbortController().signal });

/** 偽の query。step で、フックを呼び、記録を足し、結果を返す。 */
function fake(step: (o: Options, prompt: string) => Promise<{ decisions: unknown[]; subtype?: string }>) {
  const seen: { resume?: string; decisions: unknown[]; prompt: string }[] = [];
  const run = ((p: { prompt: string; options: Options }) =>
    (async function* () {
      const r = await step(p.options, p.prompt);
      await p.options.sessionStore.append({ projectKey: "p", sessionId: "s-1" }, [{ uuid: `u-${Math.random()}`, type: "user" }]);
      seen.push({ resume: p.options.resume, decisions: r.decisions, prompt: p.prompt });
      yield { type: "assistant", message: { content: [{ type: "text", text: "はい" }] } };
      yield { type: "result", subtype: r.subtype ?? "success", session_id: "s-1" };
    })()) as unknown as typeof query;
  return { run, seen };
}
const decision = (r: unknown) => (r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;

describe("Claude のエンジン", () => {
  it("画面側の道具で defer し、次の回に、保存した会話から答えを渡す。2 つ目は断る", async () => {
    const data = newThreadData("th", "alice");
    const t1 = new Thread(data);
    const first = fake(async (o) => ({ decisions: [decision(await pre(o, "ask_customer", "tu-1", { question: "受け取り方は", options: ["a", "b"] })), decision(await pre(o, "ask_customer", "tu-2", { question: "掛け金は", options: ["a", "b"] }))] }));
    await claudeRun(t1, { text: "相談したい" }, first.run);
    expect(first.seen[0]!.decisions).toEqual(["defer", "deny"]);
    expect(t1.stopped).toBe(true);
    expect(t1.waitingFor).toBeDefined();
    const saved = JSON.parse(JSON.stringify(t1.data));
    expect((saved.engine as ClaudeState).deferredId).toBe("tu-1");

    // 別のタスクが受けた次の回
    const t2 = new Thread(saved);
    const answer = t2.answer(t2.waitingFor!, JSON.stringify({ answer: "終身年金" }))!;
    const second = fake(async (o) => ({ decisions: [decision(await pre(o, "ask_customer", "tu-1", { question: "受け取り方は", options: ["a", "b"] }))] }));
    await claudeRun(t2, { answer }, second.run);
    expect(second.seen[0]).toMatchObject({ resume: "s-1", prompt: "", decisions: ["allow"] });
    expect((t2.data.engine as ClaudeState).deferredId).toBeUndefined();
    expect(Object.values((t2.data.engine as ClaudeState).transcript!)[0]).toHaveLength(2);
  });
  it("失敗した回は、会話の記録を前のままにする", async () => {
    const t = new Thread(newThreadData("th", "alice"));
    t.data.engine = { sessionId: "s-0", transcript: { k: [{ uuid: "old" }] } } satisfies ClaudeState;
    const run = fake(async () => ({ decisions: [], subtype: "error_max_turns" }));
    await claudeRun(t, { text: "こんにちは" }, run.run);
    expect(t.data.engine).toEqual({ sessionId: "s-0", transcript: { k: [{ uuid: "old" }] } });
    expect(t.events().at(-1)).toMatchObject({ end: true });
  });
  it("記録は uuid で重ねない", async () => {
    const { store, entries } = turnStore({});
    await store.append({ projectKey: "p", sessionId: "s" }, [{ uuid: "a" }, { uuid: "a" }, { type: "x" }] as never);
    expect(Object.values(entries)[0]).toHaveLength(2);
  });
});
