// 営業 AI エージェント（段 D の D1-a2-2）。顧客と AG-UI でやりとりし（gekko_11 の D-29）、意向を聞いて案を示し、書類に署名してもらい、
// 顧客の代理として提出する。契約を決める権限はない。トークン A は、受け口（main.ts）が token-guard で確かめ、
// 事務サービスを呼ぶときに B に替える（mcp.ts）。鍵は持たない。
// エンジンは、環境変数 ENGINE で選ぶ。既定は台本（scripted）。claude で本物の Claude（claude.ts）にする。トークンの有無で黙って替えない。
import { Hono } from "hono";
import { handleRun } from "./agui.ts";
import { claudeRun } from "./claude.ts";
import { scriptedRun } from "./scripted.ts";

/** 動かすエンジン。 */
export const engine = (): "claude" | "scripted" => (process.env.ENGINE === "claude" ? "claude" : "scripted");

export function createApp() {
  const app = new Hono();
  app.post("/agui", (c) => handleRun(c, engine() === "claude" ? (t, input) => claudeRun(t, input) : (t, input) => scriptedRun(t, input)));
  return app;
}
