// 段 D の D1-a2 の確かめ: ブラウザの顧客を演じ、主の流れの 2〜7 段を、入口から手口なしで通し、監査の画面で突き合わせを見る。
// ログイン → パスキーの登録 → 相談と案の提示 → 案を選ぶ → 意向確認書面と申込書に署名 → 提出 → 直送 → 照合 → 監査。
// 監査の担当（kansa）は、別のブラウザのコンテキストでログインする。顧客は監査の画面を、監査の担当は顧客のアプリを使えない。
// gekko_11 の test/ui/flow.test.ts の最初の試験と、test/ui/browser.ts の手順を写した（台本の営業 AI エージェント。案は固定）。
// ブラウザは Docker の Playwright の run-server（BROWSER_WS、既定 ws://127.0.0.1:3334/）。仮想の認証器でパスキーを作る。
// 使い方: node scripts/ui-flow.ts [origin]。既定の origin は手元の入口。DEMO_PASSWORD と USER_NAME（既定 hanako）を環境変数で渡す。
// PAUSE_FILE を渡すと、案の提示のあと、そのファイルができるまで待つ（段 D の D1-a3。途中でタスクを止める確かめ）。
import { existsSync } from "node:fs";
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

/** ログインサーバーの画面（同じ origin の /login の下）から、顧客のアプリへ戻るまで待つ。 */
const backToApp = (page: Page) => page.waitForURL((u) => u.origin === new URL(origin).origin && !u.pathname.startsWith("/login"), { timeout: 60_000 });

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
  await backToApp(page);
  expect("1 ログイン", (await visible(page, "whoami", "error").textContent()) === user);
  await page.getByTestId("tab-passkeys").click();
  await page.getByTestId("add-passkey").click();
  // 登録の画面のスクリプトが読み込み終わる前に押すと、何も起きない（CloudFront 越しでは読み込みが遅い）。読み込みを待ってから押す
  await page.waitForLoadState("networkidle");
  await page.locator("#registerWebAuthn").click();
  await backToApp(page);
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

  // 流れの途中でタスクを止める確かめ（段 D の D1-a3）。PAUSE_FILE を渡すと、案の提示のあと、そのファイルができるまで待つ。
  // 待っている間に、会話を受けたタスクを止め、続きが、ログインし直さずに、もう片方のタスクで通るかを見る
  const pauseFile = process.env.PAUSE_FILE;
  if (pauseFile) {
    log("待つ（案の提示のあと）", { pauseFile });
    while (!existsSync(pauseFile)) await page.waitForTimeout(500);
    log("続ける");
  }

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

  // 7. 照合。会話の最後と、受信箱と契約の画面の両方で、今回の申込みが「一致」になる。
  // 直送は、届かなければ保険会社のシステムが送り直すので、「一致」になるまで、最長 30 秒、照合し直す（段 D の D1-a3。plan.md の 4-3）
  const untilMatch = async (open: () => Promise<void>, testId: string) => {
    const started = Date.now();
    let status: string | null = null;
    while (Date.now() - started < 30_000) {
      await open();
      const el = page.getByTestId(testId);
      await el.waitFor({ timeout: 15_000 });
      status = await el.getAttribute("data-status");
      if (status === "match") break;
      await page.waitForTimeout(2_000);
    }
    return { status, waitedMs: Date.now() - started };
  };
  const a7 = await untilMatch(() => page.getByTestId("check-session").click(), `reconcile-${nonce}`);
  expect("7a 照合（会話の最後）", a7.status === "match", { nonce, ...a7 });
  const b7 = await untilMatch(() => page.getByTestId("tab-inbox").click(), `inbox-${nonce}`);
  expect("7b 照合（受信箱と契約）", b7.status === "match", b7);
  // 回が途中で切れて画面が送り直しても、営業 AI エージェントの文とカードが 2 重に出ていない（AG-UI の回の冪等。段 D の D1-a3）
  const cards = await page.locator("details[data-tool]").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-tool")}:${e.textContent ?? ""}`));
  const notes = await page.locator(".agent").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
  const dup = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i).map((x) => x.slice(0, 60));
  expect("7c 会話の文とカードが 2 重に出ていない", dup(cards).length === 0 && dup(notes).length === 0, { cards: cards.length, notes: notes.length, dupCards: dup(cards), dupNotes: dup(notes) });

  // 8. 監査（段 D の D1-a2-3）。顧客は、ログインサーバーにログインしていても、監査の画面を見られない。
  // ログインサーバーが、監査のクライアントの認証の流れで、役割 AUDITOR のない利用者を止める（監査サービスも重ねて確かめる）
  await page.goto(`${origin}/audit/`);
  const auditDenied = page.getByText("監査の画面には、監査の担当だけがログインできます。");
  await auditDenied.waitFor({ timeout: 30_000 });
  expect("8a 顧客は監査の画面を見られない", await auditDenied.isVisible());
  // 監査の担当が、別のブラウザで監査の画面にログインし、その契約の突き合わせを見る。記録は、届くまで少し待つことがある
  // 人が開く道と同じく、末尾のスラッシュのない /audit から入り、一覧から契約を開く
  const auditor = await (await browser.newContext()).newPage();
  await auditor.goto(`${origin}/audit`);
  // 監査の担当のログインの画面は、顧客のログインの画面と見出しが違う（取り違えないため。テーマ insurer-audit）
  const auditLoginTitle = (await auditor.locator("#kc-header-wrapper").textContent()) ?? "";
  expect("8b 監査の担当のログインの画面", auditLoginTitle.includes("監査の担当のログイン"), { title: auditLoginTitle });
  await auditor.locator("#username").fill(process.env.AUDITOR ?? "kansa");
  await auditor.locator("#password").fill(password);
  await auditor.locator("#kc-login, button[type=submit]").first().click();
  await backToApp(auditor);
  let status = "";
  let conversationRows = 0;
  for (let i = 0; i < 20; i++) {
    await auditor.goto(`${origin}/audit/`);
    const row = auditor.locator(`[data-testid=contract-${nonce}] a`);
    if (!(await row.isVisible())) {
      await auditor.waitForTimeout(3000);
      continue;
    }
    await row.click();
    if (await auditor.getByTestId("status").isVisible()) {
      status = (await auditor.getByTestId("status").textContent()) ?? "";
      conversationRows = await auditor.locator("[data-testid=conversation] tbody tr").count();
      if (status === "食い違いなし" && conversationRows > 0) break;
    }
    await auditor.waitForTimeout(3000);
  }
  expect("8b 監査の画面で、その契約が食い違いなし", status === "食い違いなし" && conversationRows > 0, { status, conversationRows });
  // 監査の担当は、顧客のアプリにログインできない（ログインサーバーが、顧客のクライアントの認証の流れで、役割 CUSTOMER のない利用者を止める）
  await auditor.goto(origin);
  await auditor.getByTestId("login").click();
  const customerDenied = auditor.getByText("顧客のアプリには、顧客の利用者だけがログインできます。");
  await customerDenied.waitFor({ timeout: 30_000 });
  expect("8c 監査の担当は顧客のアプリにログインできない", await customerDenied.isVisible());
} catch (e) {
  ok = false;
  const err = (await page.getByTestId("error").isVisible().catch(() => false)) ? await page.getByTestId("error").textContent() : null;
  log("error", { error: String(e).slice(0, 400), screen: err, url: page.url() });
  // 止まった画面を残す（local/run/ は git に入れない）
  await page.screenshot({ path: new URL("../local/run/ui-flow-error.png", import.meta.url).pathname }).catch(() => undefined);
} finally {
  await browser.close();
}
log("判定", { ok });
process.exit(ok ? 0 : 1);
