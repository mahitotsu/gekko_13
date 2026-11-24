// 台本（gekko_11 の D-23）。gekko_13 では、主の流れを本物の Claude の前に、まずこれで通す。
// Claude と同じ道具を、決まった順で呼ぶ: 質問 → 案 → 意向確認書面 → 申込書 → 提出。
// 画面側の道具を呼ぶたびに回を区切り、進みの段（engine.step）を会話の中身に残す。次の回は、どのタスクでも、その段から続ける
// （段 D の D1-a3。判断 55）。
import { callMcp } from "./mcp.ts";
import { submitSigned } from "./submit.ts";
import type { Offer } from "./draft.ts";
import type { Thread } from "./thread.ts";

/** 台本が組み立てる案。既定の条件（確定年金は 10 年、払込は 25 年）の 4 案で、金額は試算と同じ値。 */
export const SCRIPTED_PLANS = [
  { kind: "fixed", monthly: 20_000, benefit: 600_000 },
  { kind: "fixed", monthly: 40_000, benefit: 1_200_000 },
  { kind: "lifetime", monthly: 60_000, benefit: 1_200_000 },
  { kind: "lifetime", monthly: 120_000, benefit: 2_400_000 },
];

export interface Plan {
  id: string;
  name: string;
  kind: string;
  benefit: number;
  monthly: number;
}

/** 台本の進み。答えを待っている画面側の道具に当たる。 */
interface Script {
  step?: "kind" | "offers" | "intent" | "application" | "resubmit";
  /** 顧客が答えた受け取り方。 */
  kind?: string;
  /** 顧客が選んだ案の番号。 */
  planId?: string;
}

/** 回への入力。顧客の文（text）か、待っている画面側の道具への答え（answer。Thread.answer が LLM に渡す形にした文）。 */
export type Input = { text: string } | { answer: string };

const planName = (offer: Offer | undefined, planId: string) => {
  const plan = offer?.offerSet.plans.find((p) => p.id === planId);
  return `「${plan?.name ?? planId}」（月額の保険料 ${plan?.monthly.toLocaleString("ja-JP") ?? "?"} 円）`;
};

/** 台本の 1 回分。区切り（画面側の道具で答えを待つか、番が終わる）まで進める。 */
export async function scriptedRun(t: Thread, input: Input, call: typeof callMcp = callMcp): Promise<void> {
  const s = t.data.engine as Script;
  const finish = (text?: string) => {
    if (text) t.say(text);
    t.data.engine = {};
    t.end();
  };
  if ("text" in input) {
    t.data.engine = {};
    if (/契約の?(一覧|状況)|照会/.test(input.text)) {
      const r = await call(t.ctx, "list_contracts");
      return finish(r.isError ? `契約を調べられませんでした: ${JSON.stringify(r.body)}` : `契約は ${r.body.contracts?.length ?? 0} 件です。`);
    }
    t.data.engine = { step: "kind" } satisfies Script;
    return t.frontend("ask_customer", {
      question: "年金の受け取り方は、どちらをお考えですか。",
      options: ["決まった期間に受け取る（確定年金）", "生きている間ずっと受け取る（終身年金）"],
    });
  }
  const answer = input.answer;
  switch (s.step) {
    case "kind": {
      const r = await call(t.ctx, "issue_offer", { plans: SCRIPTED_PLANS });
      if (r.isError || r.body.error) return finish(`案を取得できませんでした: ${JSON.stringify(r.body)}`);
      t.setOffer(r.body as unknown as Offer);
      t.data.engine = { step: "offers", kind: answer } satisfies Script;
      return t.frontend("present_offers", { message: "保険会社が用意した案です。比べて、1 つ選んでください。" });
    }
    case "offers": {
      const planId = /選んだ案: (\S+)/.exec(answer)?.[1];
      if (!planId) return finish("案が選ばれなかったので、ここで止めます。");
      t.say(`${planName(t.offer, planId)}で、意向確認書面を用意しました。内容を確かめて、署名してください。`);
      t.data.engine = { ...s, step: "intent", planId } satisfies Script;
      return t.frontend("present_intent", { planId, wish: `老後の生活費に備えたい（受け取り方: ${s.kind}）` });
    }
    case "intent": {
      if (!answer.includes("署名しました")) return finish("意向確認書面への署名がなかったので、申込みは進めません。");
      t.say(`${planName(t.offer, s.planId!)}で、申込書を用意しました。署名いただければ、保険会社へ取り次ぎます。`);
      t.data.engine = { ...s, step: "application" } satisfies Script;
      return t.frontend("present_application", { planId: s.planId });
    }
    case "application":
    case "resubmit": {
      if (s.step === "application" && !answer.includes("署名しました")) return finish("申込書への署名がなかったので、提出しません。");
      if (s.step === "resubmit" && !answer.includes("もう一度送る")) {
        t.signed = {};
        return finish("提出をやめました。");
      }
      const r = await submitSigned(t, call);
      if (r.body?.retryable === true) {
        // 届かなかった。署名済みの申込書は残してあるので、同じ申込みをもう一度送れる（保険会社のシステムは重ねない。段 D の D1-a3）
        t.data.engine = { ...s, step: "resubmit" } satisfies Script;
        return t.frontend("ask_customer", {
          question: "保険会社に、申込みが届きませんでした。署名済みの申込書は残してあります。もう一度送りますか。",
          options: ["もう一度送る", "やめる"],
        });
      }
      return finish(
        r.isError || r.body?.error
          ? `提出を断られました: ${JSON.stringify(r.body)}`
          : `署名済みの申込書を、保険会社へ取り次ぎました（${r.body?.contract?.contractId ?? ""}）。契約内容は、保険会社から直接届きます。`,
      );
    }
    default:
      return finish("続ける会話がありません。最初から話しかけてください。");
  }
}
