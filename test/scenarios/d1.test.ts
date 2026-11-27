// 段 D の D1-b: D1 の 15 のシナリオのうち、画面のもの（8）を除く 14 件（plan.md の 4-4）。gekko_11 の test/cluster/scenarios.test.ts を写して直した。
// gekko_13 は防御を外す版を持たないので、各シナリオで「防御が全てあれば、被害は出ない」だけを確かめる（持ち主の決定、2026-11-27）。
// あわせて、攻撃に返った応答（状態と誤りの文）を記録する。どの防御で止まったかは、その応答と各サービスのログから読み、findings に書く。
// 記録は SCENARIO_OUT（既定 local/run/scenarios/<時刻>.jsonl）に 1 件 1 行で書く。
// 回し方: local/up.sh と local/up.sh probes のあと、npm run scenarios:local
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  applyArgs, atMcp, backendPost, contractsOf, Customer, exchangeAs, ISSUER, LOGIN_ISSUER, mcpCall, offerFor, probe, TERMS, type Json, type Offer, type Submission,
} from "./world.ts";

const OUT = process.env.SCENARIO_OUT ?? `local/run/scenarios/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
mkdirSync(dirname(OUT), { recursive: true });

/** 正規の経路（営業 AI エージェント → 事務サービス → 保険会社のシステム）を通った契約の経由。 */
const FULL_ROUTE = ["insurer-mcp", "sales-agent"];

// ---- 顧客（トークンの期限の前に、受け取り直す） ----
const cache = new Map<string, { at: number; c: Customer }>();
async function customer(user: string, terms: unknown = TERMS): Promise<Customer> {
  const key = `${user}:${JSON.stringify(terms)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 200_000) return hit.c;
  const c = await new Customer(user).setup(terms);
  cache.set(key, { at: Date.now(), c });
  return c;
}

/** 攻撃に返った応答を、記録に残せる形に縮める（トークンと署名は残さない）。 */
function summary(r: unknown): Json {
  if (!r || typeof r !== "object") return { value: String(r) };
  const o = r as Json;
  const body = typeof o.body === "string" ? o.body.slice(0, 300) : JSON.stringify(o.body ?? o).slice(0, 300);
  return { status: o.status, isError: o.isError, body: body.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "<token>") };
}

// ---- シナリオの型 ----
// defenses: gekko_11 の scenarios の 3 章の「止める防御」（どれか 1 つでもあれば被害が出ない）。記録のために持つ。
function scenario<C>(
  n: number,
  title: string,
  s: { defenses: string[]; prepare: () => Promise<C>; attack: (c: C) => Promise<unknown>; harmed: (c: C) => Promise<boolean> },
) {
  describe(`${n}. ${title}`, () => {
    it("防御が全てあれば、被害は出ない", async () => {
      const c = await s.prepare();
      let response: unknown;
      // 途中で拒否されても、被害の有無で判定する
      try {
        response = await s.attack(c);
      } catch (e) {
        response = { error: (e as Error).message };
      }
      const harmed = await s.harmed(c);
      appendFileSync(OUT, `${JSON.stringify({ n, title, defenses: s.defenses, harmed, response: summary(response), at: new Date().toISOString() })}\n`);
      expect(harmed).toBe(false);
    });
  });
}

// ---- 補助 ----
const submitViaMcp = async (token: string, s: Submission, extras?: Json) => mcpCall(token, "submit_application", applyArgs(s, extras));
const unsigned = (s: Submission): Submission => ({ ...s, assertion: null, intentAssertion: null });
const planOf = (offer: Offer, id: string) => offer.offerSet.plans.find((p) => p.id === id)!;
const decode = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Json;
const recorded = async (nonce: string, pred: (c: Json) => boolean = () => true) => (await contractsOf(nonce)).some(pred);
const offRoute = (c: Json) => JSON.stringify(c.by) !== JSON.stringify(FULL_ROUTE);
const signedFor = async () => {
  const alice = await customer("alice");
  const offer = await offerFor(alice);
  return { alice, offer, sub: alice.prepare(offer, "fixed-60") };
};

/** ログインサーバーの鍵ではない鍵で署名した、偽の A。形は、本物と同じである。 */
async function forgedA(sub: string, verified: unknown) {
  const { privateKey } = await generateKeyPair("RS256");
  return new SignJWT({ azp: "customer-app", scope: "openid apply", authorization_details: TERMS, verified_claims: verified, may_act: { iss: ISSUER(), sub: "sales-agent" } })
    .setProtectedHeader({ alg: "RS256", kid: "forged", typ: "at+jwt" })
    .setIssuer(LOGIN_ISSUER())
    .setSubject(sub)
    .setAudience("sales-agent")
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

// ======== R1 他人名義の申込みが通る ========
scenario(1, "R1 × A1: 営業 AI エージェントが欄に「bob」と書き、bob 名義で申し込む", {
  defenses: ["G2 自分の資格", "G9", "G11", "G13", "G14"],
  prepare: async () => {
    const alice = await customer("alice");
    const offer = await offerFor(await customer("bob"));
    const sub = alice.prepare(offer, "fixed-60");
    return { alice, sub: unsigned({ ...sub, application: { ...sub.application, customer: "bob" }, intent: { ...sub.intent, customer: "bob" } }), offer };
  },
  attack: async ({ alice, sub }) => submitViaMcp(await atMcp(alice), sub, { verified_claims: decode(alice.token).verified_claims }),
  harmed: async ({ offer }) => recorded(offer.nonce, (c) => c.contract.customer === "bob"),
});

scenario(25, "R1 × A21: ログインサーバーを名乗って偽の A を作り、bob の代理のトークンに替えさせる", {
  defenses: ["G28"],
  prepare: async () => ({ verified: decode((await customer("bob")).token).verified_claims, sub: undefined as unknown }),
  attack: async (c) => {
    const b = await exchangeAs("probe-sales-agent", await forgedA("bob", c.verified), "insurer-mcp");
    c.sub = b.body?.access_token ? decode(b.body.access_token).sub : undefined;
    return b;
  },
  harmed: async (c) => c.sub === "bob",
});

// ======== R4 署名した内容と違う契約になる ========
// gekko_11 は、乗っ取られた営業 AI エージェントの書き換えを、vulnerable の管理のポートで入れた。gekko_13 は管理のポートを持たないので、
// 乗っ取られた営業 AI エージェントの役が、顧客が署名した 2 つの書類の申込みの案だけを替えて、自分で提出する
scenario(7, "R4 × A8: 営業 AI エージェントが、署名のあとで申込みの内容を書き換える", {
  defenses: ["G13", "G14"],
  prepare: async () => {
    const { alice, offer, sub } = await signedFor();
    return { alice, offer, sub: { ...sub, application: { ...sub.application, plan: planOf(offer, "life-120") } } };
  },
  attack: async ({ alice, sub }) => submitViaMcp(await atMcp(alice), sub),
  harmed: async ({ offer }) => recorded(offer.nonce, (c) => c.contract.plan.id !== "fixed-60"),
});

scenario(9, "R4 × A10: 意向確認と申込みの間で、内容をすり替える", {
  defenses: ["G14"],
  // 顧客は「確定年金 10年・年額60万円」の意向確認に署名したが、申込みは「終身年金・年額120万円」に署名してしまった
  prepare: async () => {
    const alice = await customer("alice");
    const offer = await offerFor(alice);
    const sub = alice.prepare(offer, "fixed-60");
    const application = { ...sub.application, plan: planOf(offer, "life-120") };
    return { alice, offer, sub: { ...sub, application, assertion: alice.sign(application) } };
  },
  attack: async ({ alice, sub }) => submitViaMcp(await atMcp(alice), sub),
  harmed: async ({ offer }) => recorded(offer.nonce, (c) => c.contract.plan.id === "life-120"),
});

scenario(10, "R4 × A14: 申込みと違う内容で、契約を記録させる", {
  defenses: ["G17"],
  prepare: signedFor,
  attack: async ({ alice, offer, sub }) => submitViaMcp(await atMcp(alice), sub, { contractEntry: { plan: planOf(offer, "life-240") } }),
  harmed: async ({ offer }) => recorded(offer.nonce, (c) => c.contract.plan.id === "life-240"),
});

// ======== R5 二重の契約 ========
scenario(11, "R5 × A11: 同じ申込みを二度出す", {
  defenses: ["G16"],
  prepare: signedFor,
  attack: async ({ alice, sub }) => {
    const b = await atMcp(alice);
    await submitViaMcp(b, sub);
    return submitViaMcp(b, sub);
  },
  harmed: async ({ offer }) => (await contractsOf(offer.nonce)).length >= 2,
});

// ======== R6 取決めの外の契約 ========
scenario(12, "R6 × A12: 取決めの上限を超える案で申し込む", {
  defenses: ["G15"],
  prepare: async () => {
    const alice = await customer("alice");
    const offer = await offerFor(alice);
    return { alice, offer, sub: alice.prepare(offer, "life-240") };
  },
  attack: async ({ alice, sub }) => submitViaMcp(await atMcp(alice), sub),
  harmed: async ({ offer }) => recorded(offer.nonce),
});

// ======== R7 正規の経路を外れた申込み ========
scenario(14, "R7 × A6: 営業 AI エージェント宛ての A で、保険会社のシステムへ直接申し込む", {
  defenses: ["G7", "G10", "G26 保険会社のシステム", "G29 保険会社のシステム"],
  prepare: signedFor,
  attack: async ({ alice, sub }) => backendPost(alice.token, sub),
  harmed: async ({ offer }) => recorded(offer.nonce, offRoute),
});

scenario(16, "R7 × A7: 営業 AI エージェントが、A を事務サービスへそのまま出す", {
  defenses: ["G1", "G26 事務サービス", "G29 事務サービス", "G2 素通し", "G7", "G10", "G26 保険会社のシステム", "G29 保険会社のシステム"],
  prepare: signedFor,
  attack: async ({ alice, sub }) => submitViaMcp(alice.token, sub),
  harmed: async ({ offer }) => recorded(offer.nonce, offRoute),
});

scenario(18, "R7 × A13: 登録が外れた営業 AI エージェントが取り次いだ申込みを出す", {
  defenses: ["G10"],
  prepare: async () => ({ ...(await signedFor()), b: "" }),
  attack: async (c) => {
    c.b = await atMcp(c.alice);
    await probe("probe-operator", "operator", { action: "revoke", client: "sales-agent" });
    try {
      return await submitViaMcp(c.b, c.sub);
    } finally {
      await probe("probe-operator", "operator", { action: "restore", client: "sales-agent" });
    }
  },
  harmed: async ({ offer }) => recorded(offer.nonce),
});

// ======== R8 通知が顧客に届かない ========
scenario(19, "R8 × A15: 契約内容の通知先を、営業 AI エージェントが書いた連絡先にする", {
  defenses: ["G18"],
  prepare: signedFor,
  attack: async ({ alice, sub }) => submitViaMcp(await atMcp(alice), sub, { contact: "http://attacker.invalid/notices" }),
  harmed: async ({ alice, offer }) => {
    // 直送は裏で送るので、届くまで少し待つ（段 D の D1-a3）
    for (let i = 0; i < 10; i++) {
      if ((await alice.notices()).some((n) => n.contract.nonce === offer.nonce)) return false;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return true;
  },
});

// ======== R9 取り次いだ窓口が記録に残らない ========
scenario(20, "R9 × A16: 経由を残さない発行で、取り次いだ窓口が記録に残らない", {
  defenses: ["G3d"],
  prepare: signedFor,
  attack: async ({ alice, sub }) => submitViaMcp(await atMcp(alice), sub),
  harmed: async ({ offer }) => recorded(offer.nonce, offRoute),
});

// ======== R10 盗んだトークンが使える ========
scenario(22, "R10 × A18: 盗んだ A を、DPoP の鍵なしで使い、契約を照会させる", {
  defenses: ["G26 営業 AI エージェント"],
  prepare: async () => ({ alice: await customer("alice"), r: {} as Json }),
  attack: async (c) => {
    const input = { threadId: crypto.randomUUID(), runId: crypto.randomUUID(), messages: [{ id: "m1", role: "user", content: "契約の一覧を見せて" }], tools: [], state: {}, context: [], forwardedProps: {} };
    c.r = await c.alice.agui(input, "none");
    return c.r;
  },
  harmed: async ({ r }) => r.status === 200 && /契約は \d+ 件/.test(String(r.body)),
});

scenario(23, "R10 × A19: 盗んだ B を、別のサービスの SVID で使い、契約を照会する", {
  defenses: ["G26 事務サービス", "G27 事務サービス"],
  prepare: async () => ({ b: await atMcp(await customer("alice")), r: {} as Json }),
  attack: async (c) => (c.r = await mcpCall(c.b, "list_contracts", {}, "probe-intruder")),
  harmed: async ({ r }) => r.status === 200 && Array.isArray(r.body?.contracts),
});
