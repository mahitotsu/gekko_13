import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { contentSecurityPolicy, createApp, handleNotice } from "../src/app.ts";
import { reconcile } from "../src/reconcile.ts";

const notice = { customer: "alice", contract: { contractId: "C-1", nonce: "n-1" } };
const id = (svc: string) => `spiffe://gekko13.internal/svc/${svc}`;

describe("画面の CSP（gekko_11 の G32）", () => {
  it("スクリプトとスタイルは配信元だけで、つなぐ先は自分の配信元（BFF）だけである", () => {
    Object.assign(process.env, { AGENT_ORIGIN: "http://agent.test", AUTH_ORIGIN: "http://auth.test", ISSUER: "http://login.test/realms/insurer" });
    const policy = contentSecurityPolicy();
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("unsafe");
    expect(policy).toContain("connect-src 'self';");
    expect(policy).toContain("style-src 'self'");
  });
});

describe("直送の受け口", () => {
  it("保険会社のシステムからの通知だけを受ける", async () => {
    // mTLS の層が確かめた相手の SPIFFE ID を、ヘッダーで渡して受け口を呼ぶ（TLS の層は spiffe-tls の試験で確かめる）
    const server = createServer((req, res) => void handleNotice(req, res, String(req.headers["x-peer"] ?? "")));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const app = createApp();
    const inbox = "Abcdefghijklmnopqrstuv";
    const post = async (peer: string, box = inbox) =>
      (await fetch(`http://127.0.0.1:${port}/notices/${box}`, { method: "POST", headers: { "content-type": "application/json", "x-peer": peer }, body: JSON.stringify(notice) })).status;
    expect(await post(id("sales-agent"))).toBe(403);
    expect(await post("")).toBe(403);
    expect(await post(id("insurer-backend"), "short")).toBe(400);
    expect(await post(id("insurer-backend"))).toBe(204);
    expect(await (await app.request(`/api/inbox/${inbox}`)).json()).toEqual([notice]);
    // 番号を知らなければ、読めない
    expect(await (await app.request("/api/inbox/Zbcdefghijklmnopqrstuv")).json()).toEqual([]);
    // 画面の受け口（平文の HTTP）では、通知を受けない
    expect((await app.request(`/notices/${inbox}`, { method: "POST", body: "{}" })).status).toBe(404);
    server.close();
  });
});

describe("照合", () => {
  const plan = { id: "fixed-60", benefit: 600_000, monthly: 20_000 };
  const copy = { customer: "alice", plan, offerSetId: "s", nonce: "n-1" };
  it("一致、食い違い、未着、覚えのない通知を見分ける", () => {
    expect(reconcile([copy], [{ contract: { ...copy } }])[0]?.status).toBe("match");
    const other = { ...copy, plan: { ...plan, id: "life-240", monthly: 120_000 } };
    expect(reconcile([copy], [{ contract: other }])[0]).toMatchObject({ status: "mismatch", diffs: ["案", "保険料"] });
    expect(reconcile([copy], [])[0]?.status).toBe("missing");
    expect(reconcile([], [{ contract: copy }])[0]?.status).toBe("unexpected");
  });
});
