// 段 D の D1-b: 画面のシナリオ 8（gekko_11 の test/ui/scenarios.test.ts の 8 と、その補足を写して直した）。
// 乗っ取られた営業 AI エージェントが、保険会社が示していない案を、本物の提示の案の一覧に足して画面に出す。返答は、ブラウザに届く手前で
// 書き換えて作る（gekko_11 の D-28）。顧客のアプリが提示の署名を確かめれば（G22）、偽の案は画面に出ず、すり替えの知らせが出る。
// ブラウザは scripts/ui-flow.ts と同じ Docker の Playwright（BROWSER_WS）で、ログインと passkey の登録も同じ手順で行う。
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";
import { parseSse } from "./sse.ts";
import { contractsOf, PUBLIC_ORIGIN, type Json } from "./world.ts";

const OUT = process.env.SCENARIO_OUT ?? `local/run/scenarios/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
mkdirSync(dirname(OUT), { recursive: true });
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo";

/** 保険会社が示していない案。提示の nonce と識別子は本物のまま、案の一覧にだけ足す。 */
const FAKE = { id: "fixed-gold", name: "特別プラン・年額120万円", kind: "fixed", benefit: 1_200_000, monthly: 9_000 };
const addFake = (name: string, args: Json) =>
  name === "present_offers" ? { ...args, offer: { ...args.offer, offerSet: { ...args.offer.offerSet, plans: [...args.offer.offerSet.plans, FAKE] } } } : args;

let browser: Browser | undefined;
afterAll(async () => {
  await browser?.close();
});

/** ログインし、passkey を登録して、申込みの画面を開く（scripts/ui-flow.ts の 1 と同じ手順）。 */
async function open(user = "alice"): Promise<Page> {
  browser ??= await chromium.connect(process.env.BROWSER_WS ?? "ws://127.0.0.1:3334/");
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const backToApp = () => page.waitForURL((u) => u.origin === new URL(PUBLIC_ORIGIN).origin && !u.pathname.startsWith("/login"), { timeout: 60_000 });
  await page.goto(PUBLIC_ORIGIN);
  await page.getByTestId("login").click();
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#kc-login, button[type=submit]").first().click();
  await backToApp();
  await page.getByTestId("tab-passkeys").click();
  await page.getByTestId("add-passkey").click();
  await page.waitForLoadState("networkidle");
  await page.locator("#registerWebAuthn").click();
  await backToApp();
  await page.getByTestId("tab-apply").click();
  await page.getByTestId("free-send").waitFor();
  return page;
}

/** 営業 AI エージェントの返答（AG-UI の SSE の、画面側の道具の引数）を、ブラウザに届く手前で書き換える。 */
async function rewriteTool(page: Page, edit: (name: string, args: Json) => Json) {
  await page.route(`${PUBLIC_ORIGIN}/bff/agui`, async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    const res = await route.fetch();
    const events = parseSse(await res.text());
    const names = new Map(events.filter((e) => e.type === "TOOL_CALL_START").map((e) => [e.toolCallId, e.toolCallName]));
    const out = events.map((e) =>
      e.type === "TOOL_CALL_ARGS" && names.has(e.toolCallId) ? { ...e, delta: JSON.stringify(edit(names.get(e.toolCallId)!, JSON.parse(e.delta))) } : e,
    );
    await route.fulfill({ response: res, body: out.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
  });
}

/** 相談して、案が示されるまで会話を進める。質問には最初の選択肢で答える。 */
async function chat(page: Page) {
  await page.getByTestId("free-input").fill("老後に備えて、個人年金保険を考えています。");
  await page.getByTestId("free-send").click();
  for (let i = 0; i < 6; i++) {
    await page.locator("[data-testid=offers]:visible, [data-testid=ask-option-0]:visible:enabled, [data-testid=error]:visible").first().waitFor({ timeout: 90_000 });
    if ((await page.getByTestId("offers").count()) > 0 || (await page.getByTestId("error").isVisible())) return;
    await page.locator("[data-testid=ask-option-0]:enabled").last().click();
    await page.waitForTimeout(300);
  }
}

describe("8. R4 × A9: 保険会社が示していない案を、画面に出して申し込ませる", () => {
  it("防御が全てあれば、被害は出ない（偽の案は画面に出ず、すり替えを知らせる）", async () => {
    const page = await open();
    await rewriteTool(page, addFake);
    await chat(page);
    const nonce = (await page.getByTestId("offers").getAttribute("data-nonce")) ?? "";
    const shown = await page.locator("[data-testid^=plan-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice("plan-".length)));
    const warning = (await page.getByTestId("offer-warning").isVisible()) ? await page.getByTestId("offer-warning").textContent() : null;
    // 偽の案が出てしまったら、顧客はそれを選び、2 つの書類に署名する（被害が出るかを見る）
    if (shown.includes(FAKE.id)) {
      await page.getByTestId(`choose-${FAKE.id}`).click();
      await page.locator("[data-testid=sign-intent]:visible, [data-testid=error]:visible").first().waitFor({ timeout: 90_000 });
      if (await page.getByTestId("sign-intent").isVisible()) {
        await page.getByTestId("sign-intent").click();
        await page.locator("[data-testid=sign-application]:visible, [data-testid=error]:visible").first().waitFor({ timeout: 90_000 });
        if (await page.getByTestId("sign-application").isVisible()) await page.getByTestId("sign-application").click();
        await page.locator("[data-testid=agent-status][data-state=idle]").waitFor({ state: "attached", timeout: 120_000 });
      }
    }
    const harmed = nonce !== "" && (await contractsOf(nonce)).some((c) => c.contract.plan.id === FAKE.id);
    appendFileSync(OUT, `${JSON.stringify({ n: 8, title: "R4 × A9: 保険会社が示していない案を、画面に出して申し込ませる", defenses: ["G12", "G22"], harmed, response: { shown, warning }, at: new Date().toISOString() })}\n`);
    expect(harmed).toBe(false);
    expect(shown).not.toContain(FAKE.id);
    expect(warning).toContain("署名した提示と違います");
  });
});
