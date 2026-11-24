// 営業 AI エージェントとの AG-UI（gekko_11 の D-29）。@ag-ui/client を使い、要求ごとに、トークン A と DPoP の proof を付ける。
// 営業 AI エージェントは token-guard の後ろにいる。
import { HttpAgent } from "@ag-ui/client";
import type { Tool } from "@ag-ui/core";

/** 画面側の道具（RunAgentInput.tools）。営業 AI エージェントが呼び、この画面が顧客の答えを返す。 */
export const FRONTEND_TOOLS: Tool[] = [
  { name: "ask_customer", description: "顧客に、選択肢のある質問をする", parameters: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question", "options"] } },
  { name: "present_offers", description: "保険会社の署名つきの提示を示し、顧客に 1 つ選んでもらう", parameters: { type: "object", properties: { message: { type: "string" }, reasons: { type: "object" }, offer: { type: "object" } }, required: ["offer"] } },
  { name: "present_intent", description: "意向確認書面を示し、顧客に署名してもらう（署名 1/2）", parameters: { type: "object", properties: { intent: { type: "object" } }, required: ["intent"] } },
  { name: "present_application", description: "申込書を示し、顧客に署名してもらう（署名 2/2）", parameters: { type: "object", properties: { application: { type: "object" } }, required: ["application"] } },
];

export interface AgentHandlers {
  onText(content: string): void;
  onToolCall(id: string, name: string, args: Record<string, unknown>): void;
  onRunError(message: string): void;
}

/** 断られた要求の状態。401 なら、更新して送り直す。 */
export const statusOf = (e: unknown): number | undefined => (e as { status?: number } | undefined)?.status;

/** つなぎの失敗か。入口か BFF の 502、503、504 と、状態のないネットワークの誤り（段 D の D1-a3）。 */
export const transient = (e: unknown): boolean => {
  const status = statusOf(e);
  return status === undefined ? e instanceof TypeError : status === 502 || status === 503 || status === 504;
};

export function createAgent(url: string, headers: () => Promise<Record<string, string>>, fetcher: typeof fetch = fetch.bind(globalThis)) {
  const agent = new HttpAgent({
    url,
    threadId: crypto.randomUUID(),
    // 要求ごとに proof を作る。送り直すときも、そのときの A を使う
    fetch: async (target, init) => fetcher(target, { ...init, headers: { ...(init.headers as Record<string, string>), ...(await headers()) } }),
  });
  return {
    /**
     * 1 回分を走らせる。営業 AI エージェントの文と道具の呼び出しを、届いた順に渡す。
     * runId は、顧客の 1 つの文か答えごとに 1 つ。つなぎが切れて送り直すときは、同じ runId を渡す（営業 AI エージェントは、同じ回を流し直す）。
     */
    async run(handlers: AgentHandlers, runId: string = crypto.randomUUID()) {
      // 途中で切れた回の、文や道具の呼び出しの書きかけを、会話の履歴に残さない。同じ runId の流し直しは、同じ messageId と
      // toolCallId で届くので、残すと、文が 2 重になり、道具の引数の JSON が壊れる（段 D の D1-a3。2026-11-24 の手元）
      const before = structuredClone(agent.messages);
      await agent.runAgent(
        { tools: FRONTEND_TOOLS, runId },
        {
          onTextMessageEndEvent: ({ textMessageBuffer }) => handlers.onText(textMessageBuffer),
          onToolCallEndEvent: ({ event, toolCallName, toolCallArgs }) => handlers.onToolCall(event.toolCallId, toolCallName, toolCallArgs),
          onRunErrorEvent: ({ event }) => handlers.onRunError(event.message),
        },
      ).catch((e: unknown) => {
        agent.setMessages(before);
        throw e;
      });
    },
    say: (content: string) => agent.addMessage({ id: crypto.randomUUID(), role: "user", content }),
    answer: (toolCallId: string, content: string) => agent.addMessage({ id: crypto.randomUUID(), role: "tool", toolCallId, content }),
    abort: () => agent.abortRun(),
  };
}

export type Agent = ReturnType<typeof createAgent>;
