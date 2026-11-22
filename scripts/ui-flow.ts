// 段 D の D1-a2-2 の確かめ: ブラウザの顧客を演じ、主の流れの 2〜7 段を、入口から手口なしで通す。
// ログイン → パスキーの登録 → 相談と案の提示 → 案を選ぶ → 意向確認書面と申込書に署名 → 提出 → 直送 → 照合。
// gekko_11 の test/ui/flow.test.ts の最初の試験と、test/ui/browser.ts の手順を写した（台本の営業 AI エージェント。案は固定）。
// ブラウザは Docker の Playwright の run-server（BROWSER_WS、既定 ws://127.0.0.1:3334/）。仮想の認証器でパスキーを作る。
// 使い方: node scripts/ui-flow.ts [origin]。既定の origin は手元の入口。DEMO_PASSWORD と USER_NAME（既定 hanako）を環境変数で渡す。
import { chromium, type Page } from "playwright-core";

const origin = process.argv[2] ?? "http://gekko13.localhost:18000";
const user = process.env.USER_NAME ?? "hanako";
const password = process.env.DEMO_PASSWORD ?? "demo";
/** 台本が組み立てる案のうち、選ぶもの（gekko_11 の test/ui/browser.ts の PLANS と同じ）。 */
const CHOSEN = { id: "fixed-60", name: "確定年金 10年・年額60万円" };
const OTHERS = ["確定年金 10年・年額120万円", "終身年金・年額120万円"];

const log = (step: string, o: object = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), step, ...o }));
let ok = true;
const expect = (step: string, cond: boolean, o: object = {}) => {
  log(step, { ok: cond, ...o });
  ok &&= cond;
  if (!cond) throw new Error(`${step} が通らない`);
};
const visible = (page: Page, ...ids: string[]) => page.locator(ids.map((id) => `[data-testid=${id}]:visible`).join(", ")).first();

const browser = await chromium.connect(process.env.BROWSER_WS ?? "ws://127.0.0.1:3334/");
const context = await browser.newContext();
const page = await context.newPage();
// 失敗した要求を記録する（どこで切れたかを掴むため）
page.on("requestfailed", (r) => log("requestfailed", { url: r.url().replace(origin, ""), failure: r.failure()?.errorText }));
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

try {
  // 1. ログインし、この端末のパスキーを作る（ログインと申込みの署名で同じパスキー。gekko_11 の D-42）
  await page.goto(origin);
  await page.getByTestId("login").click();
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login, button[type=submit]").first().click();
  await page.waitForURL(`${origin}/**`);
  expect("1 ログイン", (await visible(page, "whoami", "error").textContent()) === user);
  await page.getByTestId("tab-passkeys").click();
  await page.getByTestId("add-passkey").click();
  await page.locator("#registerWebAuthn").click();
  await page.waitForURL(`${origin}/**`);
  await page.getByTestId("tab-apply").click();
  await page.getByTestId("free-send").waitFor();

  // 2. 相談と提示。質問には最初の選択肢で答え、保険会社が署名した案が出るまで進める
  await page.getByTestId("free-input").fill("老後に備えて、個人年金保険を考えています。");
  await page.getByTestId("free-send").click();
  for (let i = 0; i < 6; i++) {
    await page.locator("[data-testid^=plan-]:visible, [data-testid=ask-option-0]:visible:enabled, [data-testid=error]:visible").first().waitFor({ timeout: 60_000 });
    if (await page.locator("[data-testid^=plan-]").first().isVisible()) break;
    if (await page.getByTestId("error").isVisible()) break;
    await page.locator("[data-testid=ask-option-0]:enabled").click();
    await page.waitForTimeout(300);
  }
  const error = (await page.getByTestId("error").isVisible()) ? await page.getByTestId("error").textContent() : null;
  const warning = (await page.getByTestId("offer-warning").isVisible()) ? await page.getByTestId("offer-warning").textContent() : null;
  const plans = await page.locator("[data-testid^=plan-]:visible").count();
  expect("2 案の提示（保険会社の署名を画面が確かめた）", !error && !warning && plans > 0, { plans, error, warning });
  const nonce = (await page.getByTestId("offers").getAttribute("data-nonce")) ?? "";

  // 3. 案を選び、意向確認書面と申込書を読んで、どちらも選んだ案なら署名する
  await page.getByTestId(`choose-${CHOSEN.id}`).click();
  await visible(page, "sign-intent", "error").waitFor({ timeout: 60_000 });
  const intent = (await page.getByTestId("intent-confirm").textContent()) ?? "";
  expect("3a 意向確認書面が選んだ案を示す", intent.includes(CHOSEN.name) && !OTHERS.some((n) => intent.includes(n)));
  await page.getByTestId("sign-intent").click();
  await visible(page, "sign-application", "error").waitFor({ timeout: 60_000 });
  const application = (await page.getByTestId("application-confirm").textContent()) ?? "";
  expect("3b 申込書が選んだ案を示す", application.includes(CHOSEN.name) && !OTHERS.some((n) => application.includes(n)));
  await page.getByTestId("sign-application").click();

  // 4〜6. 営業 AI エージェントが提出し（A→B→C の交換）、保険会社のシステムが確かめて記録し、顧客のアプリへ直送する
  await page.waitForTimeout(300);
  await page.locator("[data-testid=agent-status][data-state=idle]").waitFor({ state: "attached", timeout: 120_000 });
  const afterSubmit = (await page.getByTestId("error").isVisible()) ? await page.getByTestId("error").textContent() : null;
  expect("4-6 提出が受け付けられた", !afterSubmit, { error: afterSubmit });

  // 7. 照合。会話の最後と、受信箱と契約の画面の両方で、今回の申込みが「一致」になる
  await page.getByTestId("check-session").click();
  const item = page.getByTestId(`reconcile-${nonce}`);
  await item.waitFor({ timeout: 15_000 });
  expect("7a 照合（会話の最後）", (await item.getAttribute("data-status")) === "match", { nonce, status: await item.getAttribute("data-status") });
  await page.getByTestId("tab-inbox").click();
  const row = page.getByTestId(`inbox-${nonce}`);
  await row.waitFor({ timeout: 15_000 });
  expect("7b 照合（受信箱と契約）", (await row.getAttribute("data-status")) === "match", { status: await row.getAttribute("data-status") });
} catch (e) {
  ok = false;
  const err = (await page.getByTestId("error").isVisible().catch(() => false)) ? await page.getByTestId("error").textContent() : null;
  log("error", { error: String(e).slice(0, 400), screen: err, url: page.url() });
} finally {
  await browser.close();
}
log("判定", { ok });
process.exit(ok ? 0 : 1);
