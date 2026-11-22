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
  const b = await exchangeForNext({
    authFetch: mtlsFetch(svids, `spiffe://${trustDomain()}/svc/auth`),
    authOrigin: AUTH_ORIGIN,
    service: "sales-agent",
    next: "insurer-mcp",
    subjectToken: ctx,
  });
  const client = new Client({ name: "sales-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: mtlsFetch(svids, `spiffe://${trustDomain()}/svc/insurer-mcp`),
      requestInit: { headers: { authorization: `Bearer ${b}` } },
    }),
  );
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]?.text ?? "{}";
    return { isError: Boolean(r.isError), body: JSON.parse(text) };
  } finally {
    await client.close();
  }
}
