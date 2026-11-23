// 営業 AI エージェント（段 D の D1-a2-2）。顧客と AG-UI でやりとりし（gekko_11 の D-29）、意向を聞いて案を示し、書類に署名してもらい、
// 顧客の代理として提出する。契約を決める権限はない。トークン A は、受け口（main.ts）が token-guard で確かめ、
// 事務サービスを呼ぶときに B に替える（mcp.ts）。鍵は持たない。
// まず台本で動かす。本物の Claude（gekko_11 の claude.ts）は、主の流れが台本で通ってから足す（持ち主の決定）。
import { Hono } from "hono";
import { handleRun } from "./agui.ts";
import { scriptedRun } from "./scripted.ts";

/** 今は台本だけで動く。 */
export const engine = (): "claude" | "scripted" => "scripted";

export function createApp() {
  const app = new Hono();
  app.post("/agui", (c) => handleRun(c, (t, input) => scriptedRun(t, input)));
  return app;
}
