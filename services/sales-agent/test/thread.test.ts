import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scriptedRun } from "../src/scripted.ts";
import { digest, newThreadData, redact, Thread, type ThreadData } from "../src/thread.ts";

const plans = [{ id: "fixed-60", name: "確定年金 10年・年額60万円", kind: "fixed", benefit: 600_000, monthly: 20_000 }];
const offer = { offerJws: "jws", offerSet: { customer: "alice", plans }, offerSetId: "set-1", nonce: "n-1", expiresAt: 1 };

type Calls = { name: string; args?: Record<string, unknown> }[];

/** 事務サービスの代わり。呼ばれた道具と引数を残す。 */
function fakeMcp(calls: Calls) {
  return async (_ctx: string, name: string, args?: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "issue_offer") return { isError: false, body: offer };
    return { isError: false, body: { ok: true, contract: { contractId: "C-1" } } };
  };
}

/**
 * 1 回分を進める。会話の中身を JSON にして読み直すので、回ごとに別のタスクが受けた場合と同じになる（段 D の D1-a3。判断 55）。
 * text は顧客の文、answer は待っている画面側の道具への答え。
 */
async function turn(data: ThreadData, input: { text: string } | { answer: string }, calls: Calls) {
  const t = new Thread(JSON.parse(JSON.stringify(data)) as ThreadData);
  if ("text" in input) {
    t.tell(input.text);
    await scriptedRun(t, input, fakeMcp(calls));
  } else {
    const answer = t.answer(t.waitingFor!, input.answer);
    expect(answer).toBeDefined();
    await scriptedRun(t, { answer: answer! }, fakeMcp(calls));
  }
  if (!t.stopped) t.end();
  return { data: t.data, items: t.events() as Record<string, any>[] };
}

const toolCall = (items: Record<string, any>[]) => ({
  id: items.find((e) => e.type === "TOOL_CALL_START")?.toolCallId as string,
  name: items.find((e) => e.type === "TOOL_CALL_START")?.toolCallName as string,
  args: JSON.parse(items.find((e) => e.type === "TOOL_CALL_ARGS")?.delta ?? "{}"),
});

describe("振返りと推奨の理由（gekko_11 の P-17）", () => {
  it("最初の文を当初の意向として残し、理由を提示に足す", () => {
    const t = new Thread(newThreadData("th-review", "alice"));
    t.tell("年に 80 万円ほしい");
    t.tell("掛け金を抑えたい");
    t.setOffer(offer);
    t.frontend("present_offers", { message: "説明", reasons: { "fixed-60": "意向に近い" } });
    let c = toolCall(t.events() as Record<string, any>[]);
    expect(c.args.reasons).toEqual({ "fixed-60": "意向に近い" });
    t.answer(c.id, JSON.stringify({ planId: "fixed-60", plan: plans[0] }));
    const next = new Thread(JSON.parse(JSON.stringify(t.data)) as ThreadData);
    next.frontend("present_intent", { planId: "fixed-60", wish: "掛け金を抑えて受け取りたい", changeNote: "額より掛け金を優先した" });
    c = toolCall(next.events() as Record<string, any>[]);
    expect(c.args.intent).toMatchObject({ initialWish: "年に 80 万円ほしい", wish: "掛け金を抑えて受け取りたい", changeNote: "額より掛け金を優先した" });
  });

  it("案のカードの自由入力は、選んだ案でなく、文として渡す", () => {
    const t = new Thread(newThreadData("th-other", "alice"));
    t.setOffer(offer);
    t.frontend("present_offers", { message: "説明" });
    const c = toolCall(t.events() as Record<string, any>[]);
    expect(t.answer(c.id, JSON.stringify({ answer: "掛け金を抑えたい" }))).toBe("掛け金を抑えたい");
    expect(t.chosen).toBeUndefined();
  });

  it("待っている道具でない答えは、受けない", () => {
    const t = new Thread(newThreadData("th-wrong", "alice"));
    t.frontend("ask_customer", { question: "質問", options: ["a", "b"] });
    expect(t.answer("other-id", "a")).toBeUndefined();
    expect(t.waitingFor).toBeDefined();
  });
});

describe("台本の会話（AG-UI のイベント）", () => {
  it("質問 → 案 → 意向確認書面 → 申込書 → 提出の順に、画面側の道具を呼び、回ごとに別のタスクが続けられる", async () => {
    const calls: Calls = [];
    let r = await turn(newThreadData("th-1", "alice"), { text: "老後に備えたい" }, calls);
    let c = toolCall(r.items);
    expect(c.name).toBe("ask_customer");
    expect(r.items.at(-1)).toEqual({ pause: true });

    r = await turn(r.data, { answer: "終身年金" }, calls);
    c = toolCall(r.items);
    expect(c.name).toBe("present_offers");
    expect(c.args.offer.offerSetId).toBe("set-1"); // 提示は、決まった処理が足す

    r = await turn(r.data, { answer: JSON.stringify({ planId: "fixed-60" }) }, calls);
    c = toolCall(r.items);
    expect(c.name).toBe("present_intent");
    expect(c.args.intent).toMatchObject({ customer: "alice", planId: "fixed-60", nonce: "n-1" });
    expect(c.args.intent.wish).toContain("終身年金");

    r = await turn(r.data, { answer: JSON.stringify({ assertion: { response: { signature: "sig-1" } } }) }, calls);
    c = toolCall(r.items);
    expect(c.name).toBe("present_application");
    expect(c.args.application.intentSignature).toBe("sig-1"); // 署名の値は、決まった処理が入れる

    r = await turn(r.data, { answer: JSON.stringify({ assertion: { response: { signature: "sig-2" } } }) }, calls);
    expect(r.items.at(-1)).toEqual({ end: true, error: undefined });
    expect(r.items.find((e) => e.type === "TEXT_MESSAGE_CONTENT")?.delta).toContain("C-1");
    expect(calls.map((x) => x.name)).toEqual(["issue_offer", "submit_application"]);
    expect(calls[1]?.args).toMatchObject({ application: { plan: plans[0], intentSignature: "sig-1" } });
    // 番が終わると、進みと待っている道具は残らない。署名した書類も、提出したら消す
    expect(r.data).toMatchObject({ engine: {}, signed: {} });
    expect(r.data.pending).toBeUndefined();
  });

  it("自由入力の答えで進み、JSON として読める文（null など）でも止まらない", async () => {
    const calls: Calls = [];
    // 「契約」の語を含む希望でも、一覧の照会にならず、質問へ進む
    let r = await turn(newThreadData("th-free", "alice"), { text: "個人年金の契約を考えています" }, calls);
    expect(toolCall(r.items).name).toBe("ask_customer");
    r = await turn(r.data, { answer: JSON.stringify({ answer: "10 年だけ受け取りたい" }) }, calls);
    r = await turn(r.data, { answer: JSON.stringify({ planId: "fixed-60" }) }, calls);
    expect(JSON.stringify(toolCall(r.items).args)).toContain("10 年だけ受け取りたい");
    r = await turn(r.data, { answer: JSON.stringify({ declined: true }) }, calls);
    expect(r.items.at(-1)).toMatchObject({ end: true });

    for (const text of ["null", "123", "true", "\"文\""]) {
      const n = new Thread(newThreadData(`th-${text}`, "alice"));
      n.frontend("ask_customer", { question: "質問", options: ["a", "b"] });
      expect(n.answer(n.waitingFor!, text)).toBe(text);
    }
  });

  it("書類への署名を断ると、提出しない", async () => {
    const calls: Calls = [];
    let r = await turn(newThreadData("th-2", "alice"), { text: "案を見たい" }, calls);
    r = await turn(r.data, { answer: "確定年金" }, calls);
    r = await turn(r.data, { answer: JSON.stringify({ planId: "fixed-60" }) }, calls);
    r = await turn(r.data, { answer: JSON.stringify({ declined: true }) }, calls);
    expect(r.items.at(-1)).toMatchObject({ end: true });
    expect(calls.map((x) => x.name)).toEqual(["issue_offer"]);
  });

  it("契約の照会は、画面側の道具を呼ばずに、その回で番を終える", async () => {
    const calls: Calls = [];
    const r = await turn(newThreadData("th-list", "alice"), { text: "契約の一覧を見たい" }, calls);
    expect(calls.map((x) => x.name)).toEqual(["list_contracts"]);
    expect(r.items.at(-1)).toMatchObject({ end: true });
    expect(r.data.pending).toBeUndefined();
  });
});

describe("会話の記録（gekko_11 の D-32）", () => {
  it("トークン、署名の値、提示の JWS を伏せる", () => {
    const out = redact({ application: { plan: { id: "fixed-60" }, intentSignature: "sig" }, assertion: { response: { signature: "s" } }, offerJws: "jws", text: "老後に備えたい" }) as Record<string, any>;
    expect(out).toEqual({ application: { plan: { id: "fixed-60" }, intentSignature: "（伏せた）" }, assertion: "（伏せた）", offerJws: "（伏せた）", text: "老後に備えたい" });
  });
});

describe("書類のハッシュ", () => {
  it("JCS で正規化した内容の SHA-256（鍵の順に依らない）", () => {
    expect(digest({ b: 1, a: "あ" })).toBe(digest({ a: "あ", b: 1 }));
    expect(digest({ a: "あ", b: 1 })).toBe(createHash("sha256").update('{"a":"あ","b":1}').digest("base64url"));
  });
});
