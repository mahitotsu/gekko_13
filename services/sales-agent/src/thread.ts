// 会話（AG-UI の thread）ごとの状態と、AG-UI のイベントの列（gekko_11 の D-29）。Claude と台本の両方が、これを通して顧客とやりとりする。
// 画面側の道具（顧客への質問と書類の提示）を呼ぶと、イベントを出してその回を区切る。顧客の答えは、次の回の tool message で届く。
// 会話の中身（ThreadData）は、区切りごとに共有のデータベースに書き、次の回は、どのタスクでも続けられる（段 D の D1-a3。判断 55）。
// 書類の識別子と署名の値は、LLM ではなく、ここが直前の提示と画面の回答から入れる（gekko_11 の D-27）。
import { createHash, randomUUID } from "node:crypto";
import canonicalize from "canonicalize";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { applicationOf, intentOf, type Application, type Intent, type Offer } from "./draft.ts";
import type { Plan } from "./scripted.ts";

/** 画面側の道具。営業 AI エージェントが呼び、顧客のアプリが画面で答える。 */
export const FRONTEND_TOOLS = ["ask_customer", "present_offers", "present_intent", "present_application"] as const;
export type FrontendTool = (typeof FRONTEND_TOOLS)[number];

/** 会話の記録で伏せる欄。トークン、署名の値、提示の JWS は残さない（gekko_11 の D-32）。 */
const SECRET_KEYS = new Set(["assertion", "intentAssertion", "intent_assertion", "signature", "intentSignature", "offerJws", "offer_jws", "token"]);

/** 値を複製し、伏せる欄を「（伏せた）」に置き換える。 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.has(k) ? "（伏せた）" : redact(v)]));
  }
  return value;
}

/** JCS（RFC 8785）で正規化した内容の SHA-256 の base64url。事務サービスのハッシュと同じ算出（監査の突き合わせ。gekko_11 の D-32）。 */
export const digest = (value: unknown) => createHash("sha256").update(canonicalize(value) ?? "").digest("base64url");

/** 動いているモデル（Claude か台本）。 */
const model = () =>
  process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY ? (process.env.CLAUDE_MODEL ?? "claude-haiku-5-5") : "scripted";

/** 回の区切り。PAUSE は顧客の答えを待つ、END は営業 AI エージェントの番が終わった。 */
export type Item = BaseEvent | { pause: true } | { end: true; error?: string };

export interface Signed {
  intent?: Intent;
  intentAssertion?: { response: { signature: string } } & Record<string, unknown>;
  application?: Application;
  assertion?: unknown;
}

/**
 * 会話の中身。顧客の答えを待つ区切りごとに、共有のデータベースに書く（段 D の D1-a3。判断 55）。次の回は、どのタスクでも、これを読んで続ける。
 * トークン A と、確かめた主張は、回ごとに受け口が確かめるので、置かない。
 */
export interface ThreadData {
  id: string;
  sub: string;
  /** 直前に事務サービスから受け取った提示。 */
  offer?: Offer;
  /** 顧客が署名した書類。画面が返した、顧客が実際に署名した内容をそのまま持ち、提出する。 */
  signed: Signed;
  /** 顧客が画面で選んだ案（画面が返した案の中身）。 */
  chosen?: Plan;
  /** 顧客の最初の文。意向確認書面の「当初の意向」に、そのまま入れる（gekko_11 の P-17）。 */
  initialWish?: string;
  /** 答えを待っている画面側の道具。次の回の tool message は、この id への答えだけを受ける。 */
  pending?: { id: string; name: FrontendTool; args: Record<string, unknown> };
  /** エンジン（台本、のちに本物の Claude）の進み。中身はエンジンが決める。 */
  engine: Record<string, unknown>;
}

export const newThreadData = (id: string, sub: string): ThreadData => ({ id, sub, signed: {}, engine: {} });

export class Thread {
  readonly data: ThreadData;
  /** この回で受け口が確かめたトークン A。事務サービスを呼ぶときに B に替える（mcp.ts）。 */
  ctx = "";
  /** この回の、確かめた主張（取決めを含む）。 */
  claims = "";
  /** この回のイベント。区切り（PAUSE か END）までを、回の終わりにまとめて画面へ流す。 */
  private items: Item[] = [];

  constructor(data: ThreadData) {
    this.data = data;
  }

  get id() {
    return this.data.id;
  }
  get sub() {
    return this.data.sub;
  }
  get offer() {
    return this.data.offer;
  }
  get signed() {
    return this.data.signed;
  }
  set signed(v: Signed) {
    this.data.signed = v;
  }
  get chosen() {
    return this.data.chosen;
  }

  /**
   * 会話の記録（監査の形。gekko_11 の D-32）を、1 行の JSON で書く。標準出力に書き、ECS の awslogs が CloudWatch Logs に送る。
   * 本文を残すが、トークン、署名の値、提示の JWS は伏せる。営業 AI エージェントは書き換えうる者なので、監査では証拠の 1 つとして扱う。
   */
  record(event: string, detail: Record<string, unknown> = {}) {
    const entry = { kind: "conversation", at: Math.floor(Date.now() / 1000), service: "sales-agent", thread: this.id, sub: this.sub, model: model(), event, ...detail };
    console.log(JSON.stringify({ audit: redact(entry) }));
  }

  /** 顧客の文（user message）を受け取り、記録する。 */
  tell(text: string) {
    this.record("customer_text", { text });
    this.data.initialWish ??= text;
  }

  /** 事務サービスから受け取った提示を覚え、会話の記録に、nonce と識別子を残す。 */
  setOffer(offer: Offer) {
    this.data.offer = offer;
    this.record("agent_tool", { name: "issue_offer", nonce: offer.nonce, offerSetId: offer.offerSetId });
  }

  get waitingFor(): string | undefined {
    return this.data.pending?.id;
  }

  /** 区切りまで進んだか（答えを待つか、番が終わった）。エンジンは、区切ったら、その回の処理を止める。 */
  get stopped(): boolean {
    const last = this.items.at(-1);
    return Boolean(last && ("pause" in last || "end" in last));
  }

  private push(item: Item) {
    this.items.push(item);
  }

  /** この回のイベントを、出した順に返す。 */
  events(): Item[] {
    return this.items;
  }

  /** 営業 AI エージェントの文を、顧客に送る。 */
  say(text: string) {
    if (!text.trim()) return;
    this.record("agent_text", { text });
    const messageId = randomUUID();
    this.push({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent);
    this.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text } as BaseEvent);
    this.push({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
  }

  /** 営業 AI エージェントの番が終わった。 */
  end(error?: string) {
    this.push({ end: true, error });
  }

  /**
   * 画面側の道具を呼び、回を区切る。LLM が決めた値（llmArgs）に、決まった処理が識別子と署名の値を足して、画面へ送る。
   * 顧客の答えは、次の回の tool message で届く（answer）。そのときは、別のタスクが受けてもよい。
   */
  frontend(name: FrontendTool, llmArgs: Record<string, unknown>): void {
    const args = this.argsFor(name, llmArgs);
    const toolCallId = randomUUID();
    // 示した書類のハッシュを、決まった処理が残す。LLM の会話の履歴には入らない。監査サービスが、事務サービスのハッシュと比べる
    const document = name === "present_intent" ? args.intent : name === "present_application" ? args.application : undefined;
    this.record("frontend_tool", {
      name,
      args: name === "present_offers" ? offerSummary(args) : args,
      ...(document ? { document_hash: digest(document) } : {}),
    });
    this.push({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name } as BaseEvent);
    this.push({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args) } as BaseEvent);
    this.push({ type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent);
    this.data.pending = { id: toolCallId, name, args };
    this.push({ pause: true });
  }

  /**
   * 待っている道具への答え（次の回の tool message）を受け取る。返すのは、LLM（台本）に渡す答えの文。
   * 待っている道具でなければ undefined。
   */
  answer(toolCallId: string, content: string): string | undefined {
    const pending = this.data.pending;
    if (pending?.id !== toolCallId) return undefined;
    this.data.pending = undefined;
    let answer: unknown = content;
    try {
      answer = JSON.parse(content);
    } catch {
      // 文の答えは、そのまま残す
    }
    this.record("customer_answer", { answer });
    return this.accept(pending.name, pending.args, content);
  }

  private argsFor(name: FrontendTool, llm: Record<string, unknown>): Record<string, unknown> {
    switch (name) {
      case "ask_customer":
        return { question: String(llm.question ?? ""), options: (llm.options as string[]) ?? [] };
      case "present_offers":
        if (!this.offer) throw new Error("示す提示がない（先に issue_offer を使う）");
        return { message: String(llm.message ?? ""), ...(llm.reasons ? { reasons: llm.reasons } : {}), offer: this.offer };
      case "present_intent":
        if (!this.offer) throw new Error("示す提示がない（先に issue_offer を使う）");
        return {
          intent: intentOf(this.sub, this.offer, String(llm.planId), String(llm.wish ?? ""), this.chosen, {
            initialWish: this.data.initialWish,
            changeNote: llm.changeNote ? String(llm.changeNote) : undefined,
          }),
        };
      case "present_application":
        if (!this.offer || !this.signed.intentAssertion) throw new Error("意向確認書面の署名がない（先に present_intent を使う）");
        return {
          application: applicationOf(this.sub, this.offer, String(llm.planId), this.signed.intentAssertion.response.signature, this.chosen),
        };
    }
  }

  /** 顧客の答えを受け取り、署名なら、顧客が署名した内容と署名を覚え、LLM に渡す文にする。 */
  private accept(name: FrontendTool, args: Record<string, unknown>, content: string): string {
    let answer: Record<string, unknown>;
    try {
      answer = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return content;
    }
    // 自由入力の文が、JSON として読めただけの値（「null」「123」など）は、そのままの文として扱う
    if (answer === null || typeof answer !== "object") return content;
    if (answer.declined) return "顧客は、この書類への署名を断りました。";
    if (name === "present_intent" && answer.assertion) {
      this.signed = { intent: (answer.intent ?? args.intent) as Intent, intentAssertion: answer.assertion as Signed["intentAssertion"] };
      return "顧客は、意向確認書面に署名しました。";
    }
    if (name === "present_application" && answer.assertion) {
      this.signed = { ...this.signed, application: (answer.application ?? args.application) as Application, assertion: answer.assertion };
      return "顧客は、申込書に署名しました。submit_application で提出できます。";
    }
    if (name === "present_offers" && answer.planId) {
      this.data.chosen = answer.plan as Plan | undefined;
      return `顧客が選んだ案: ${String(answer.planId)}`;
    }
    return String(answer.answer ?? content);
  }
}

/** 提示は、nonce と識別子と案の一覧だけを残す（署名の JWS は残さない）。 */
function offerSummary(args: Record<string, unknown>) {
  const offer = args.offer as Offer;
  return { message: args.message, reasons: args.reasons, offer: { nonce: offer.nonce, offerSetId: offer.offerSetId, plans: offer.offerSet.plans } };
}
