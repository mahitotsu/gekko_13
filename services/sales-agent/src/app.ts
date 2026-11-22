// 営業 AI エージェント（段 D の D1-a2-2）。顧客と AG-UI でやりとりし（gekko_11 の D-29）、意向を聞いて案を示し、書類に署名してもらい、
// 顧客の代理として提出する。契約を決める権限はない。トークン A は、受け口（main.ts）が token-guard で確かめ、
// 事務サービスを呼ぶときに B に替える（mcp.ts）。鍵は持たない。
// まず台本で動かす。本物の Claude（gekko_11 の claude.ts）は、主の流れが台本で通ってから足す（持ち主の決定）。
import { Hono } from "hono";
import { handleRun } from "./agui.ts";
import { scriptedTurn } from "./scripted.ts";
import type { Thread } from "./thread.ts";

/** 今は台本だけで動く。 */
export const engine = (): "claude" | "scripted" => "scripted";

/** 会話を始める。台本が、顧客の文を待ち、番ごとに回を閉じる。 */
export function start(t: Thread): void {
  void (async () => {
    for await (const message of t.messages()) {
      try {
        await scriptedTurn(t, message);
        t.end();
      } catch (e) {
        t.end(`営業 AI エージェント（台本）が止まりました: ${(e as Error).message}`);
      }
    }
  })();
}

export function createApp() {
  const app = new Hono();
  app.post("/agui", (c) => handleRun(c, start));
  return app;
}
