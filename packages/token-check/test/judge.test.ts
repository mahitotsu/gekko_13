import { describe, expect, it } from "vitest";
import { judge, type Policy } from "../src/index.ts";

const TRANSFER = "spiffe://gekko13.internal/svc/transfer";
const BFF = "spiffe://gekko13.internal/svc/bff";
const policy: Policy = { issuer: "x", callers: { [TRANSFER]: "transfer-client" }, requiredScope: "banking/transfer" };
const base = { token_use: "access", sub: "u1", scope: "banking/view banking/transfer" };
const delegated = (client: string, actor: string) => ({ ...base, client_id: client, act: { client_id: actor } });

describe("judge", () => {
  it("相手の SPIFFE ID と act.client_id が対応すれば通す", () => {
    const v = judge(delegated("transfer-client", "transfer-client"), TRANSFER, policy);
    expect(v).toMatchObject({ ok: true, caller: "transfer-client" });
  });

  it("前段が受けたトークンを付け替えて送ると拒む（3-c）", () => {
    expect(judge(delegated("bff-client", "bff-client"), TRANSFER, policy)).toMatchObject({ status: 403, reason: "peer_actor_mismatch" });
  });

  it("許していない相手は、トークンが正しくても拒む（3-d）", () => {
    expect(judge(delegated("bff-client", "bff-client"), BFF, policy)).toMatchObject({ status: 403, reason: "caller_not_allowed" });
  });

  it("client_id と act.client_id が食い違えば拒む（gekko_12 の実測 1-5）", () => {
    expect(judge(delegated("bff-client", "transfer-client"), TRANSFER, policy)).toMatchObject({ reason: "client_actor_mismatch" });
  });

  it("交換していない利用者のトークンは拒む", () => {
    expect(judge({ ...base, client_id: "transfer-client" }, TRANSFER, policy)).toMatchObject({ reason: "not_delegated" });
  });

  it("scope が足りなければ拒む", () => {
    const t = { ...delegated("transfer-client", "transfer-client"), scope: "banking/view" };
    expect(judge(t, TRANSFER, policy)).toMatchObject({ reason: "insufficient_scope" });
  });

  it("ID トークンは拒む", () => {
    expect(judge({ ...delegated("transfer-client", "transfer-client"), token_use: "id" }, TRANSFER, policy)).toMatchObject({ status: 401 });
  });
});
