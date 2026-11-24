// 事務サービスの MCP の道具を呼ぶ（段 D の D1-a2-2）。gekko_11 では、Envoy の出口と token-guard が、トークンを替えて付けた。
// gekko_13 では、ここで、受け口で確かめたトークン A を、認可サーバーで B（宛先は事務サービス）に替え、SVID の mTLS で呼ぶ。
// B は、替えを頼んだときの自分の証明書に結ばれる。SVID が入れ替わると前の B は使えないので、呼ぶたびに替える。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mtlsFetch, type SvidSource } from "../../../packages/spiffe-tls/src/index.ts";
import { exchangeForNext } from "../../../packages/token-guard/src/index.ts";

const trustDomain = () => process.env.TRUST_DOMAIN ?? "gekko13.internal";
export const MCP_URL = process.env.MCP_URL ?? "https://insurer-mcp:9443/mcp";
const AUTH_ORIGIN = process.env.AUTH_ORIGIN ?? "https://auth:8443";

/** SVID（spiffe-helper が書いたファイル）。main.ts が起動のときに渡す。 */
let svids: SvidSource | undefined;
export const useSvids = (source: SvidSource) => (svids = source);

/** 道具の答え。保険会社のシステムの答えの JSON で、アプリが読む欄だけに型を付ける。 */
export interface ToolBody {
  error?: unknown;
  status?: number;
  contract?: { contractId?: string };
  contracts?: unknown[];
  [name: string]: unknown;
}

export interface ToolResult {
  isError: boolean;
  body: ToolBody;
}

/** ctx は、受け口で確かめたトークン A。 */
export async function callMcp(ctx: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  if (!svids) throw new Error("SVID を読んでいない");
  // 1 回の呼び出しの間は、最初に読んだ SVID を使い続ける。交換で受け取る B は、そのときの証明書に結ばれるので、
  // 途中で SVID が入れ替わると、事務サービスへのつなぎの証明書と食い違い、not_bound で断られる（2026-11-23 の AWS。段 D の D1-a3）。
  // 古い証明書は、入れ替わったあとも期限まで有効である
  const pinned = { current: svids.current } as SvidSource;
  const b = await exchangeForNext({
    // 認可サーバーは末端なので、1 回 5 秒で見切って送り直す。事務サービスは、その中で保険会社のシステムを最長約 25 秒待つので、30 秒待つ（段 D の D1-a3）
    authFetch: mtlsFetch(pinned, `spiffe://${trustDomain()}/svc/auth`, 5_000, 3),
    authOrigin: AUTH_ORIGIN,
    service: "sales-agent",
    next: "insurer-mcp",
    subjectToken: ctx,
  });
  const client = new Client({ name: "sales-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: mtlsFetch(pinned, `spiffe://${trustDomain()}/svc/insurer-mcp`),
      requestInit: { headers: { authorization: `Bearer ${b}` } },
    }),
  );
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]?.text ?? "{}";
    // 道具の誤りは、本文が JSON でないことがある（事務サービスの SDK が、例外を「Error calling tool ...」の文で返す）。
    // そのまま読むと、ここで止まる（2026-11-24 の AWS）。文のときは、誤りの本文として返す
    try {
      return { isError: Boolean(r.isError), body: JSON.parse(text) };
    } catch {
      return { isError: true, body: { error: text } };
    }
  } finally {
    await client.close();
  }
}
