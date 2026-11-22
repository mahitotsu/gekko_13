// 共通の例（vectors/service-token.json）で、サービスのトークンの確かめが期待どおりの判定をするかを見る。
// 同じ例を、事務サービス（Python）と保険会社のシステム（Java）の試験も読む。
import { readFileSync } from "node:fs";
import { createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";
import { createGuard, Refusal } from "../src/index.ts";

const v = JSON.parse(readFileSync(new URL("../vectors/service-token.json", import.meta.url), "utf8"));
const guard = createGuard({
  service: v.service,
  issuer: v.issuer,
  keys: createLocalJWKSet(v.jwks),
  ingress: "mtls",
  allowedCallers: v.allowedCallers,
  now: () => v.now,
});

describe("共通の例（サービスのトークン）", () => {
  for (const c of v.cases) {
    it(`${c.name} → ${c.expect}`, async () => {
      const got = await guard({ method: "POST", url: "https://insurer-mcp:9443/mcp", authorization: c.authorization }, c.peer).then(
        () => "ok",
        (e) => (e instanceof Refusal ? e.reason : `unexpected: ${String(e)}`),
      );
      expect(got).toBe(c.expect);
    });
  }
});
