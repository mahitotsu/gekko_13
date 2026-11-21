// 段 D の D1-a2-1 の確かめ: ブラウザの顧客を演じ、ログインとパスキーを入口から通す（plan.md の D1-a2 の予測 1、2）。
// 1. パスワードでログインし、BFF がトークン A と P を受け取る（受信箱の登録と、passkey の一覧の読み取りが通る）
// 2. ログインサーバーの画面でパスキーを登録する（仮想の認証器。gekko_11 の D-28 と同じ）
// 3. サインアウトし、パスキーだけでログインし直す。ログインサーバーへ送ったのがパスワードでなく、パスキーの署名であることを見る
// ブラウザは Docker の Playwright の run-server（BROWSER_WS、既定 ws://127.0.0.1:3334/）。手元にブラウザを入れない。
// 使い方: node scripts/ui-login.ts [origin]。既定の origin は手元の入口。DEMO_PASSWORD と USER_NAME（既定 alice）を環境変数で渡す。
import { chromium, type Request } from "playwright-core";

const origin = process.argv[2] ?? "http://gekko13.localhost:18000";
const user = process.env.USER_NAME ?? "alice";
const password = process.env.DEMO_PASSWORD ?? "demo";
const log = (step: string, o: object = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), step, ...o }));

const browser = await chromium.connect(process.env.BROWSER_WS ?? "ws://127.0.0.1:3334/");
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
const session = async () => JSON.parse(await page.evaluate(async () => (await fetch("/bff/session", { headers: { "x-bff": "1" } })).text()));
let ok = true;
const expect = (step: string, cond: boolean, o: object = {}) => {
  log(step, { ok: cond, ...o });
  ok &&= cond;
};

try {
  await page.goto(origin);
  await page.getByTestId("login").click();
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login, button[type=submit]").first().click();
  await page.waitForURL(`${origin}/**`);
  await page.getByTestId("whoami").waitFor();
  const s1 = await session();
  expect("1 パスワードでログイン", s1.sub === user && s1.inboxRegistered === true && Array.isArray(s1.passkeys?.passkeys), { session: s1 });

  await page.getByTestId("tab-passkeys").click();
  await page.getByTestId("add-passkey").click();
  await page.locator("#registerWebAuthn").click();
  await page.waitForURL(`${origin}/**`);
  await page.getByTestId("whoami").waitFor();
  const s2 = await session();
  // 登録の結果（passkeyAction）は、画面が先に 1 度だけ読むので、ここでは一覧の件数で見る
  expect("2 パスキーを登録", s2.passkeys?.passkeys?.length >= 1, { count: s2.passkeys?.passkeys?.length });

  await page.getByTestId("signout").click();
  await page.getByTestId("login").waitFor({ timeout: 30_000 });
  const sent = { passkey: false, password: false };
  const watch = (r: Request) => {
    if (r.method() !== "POST" || !r.url().includes("/login-actions/authenticate")) return;
    const body = new URLSearchParams(r.postData() ?? "");
    if (body.get("credentialId") && body.get("signature")) sent.passkey = true;
    if (body.get("password")) sent.password = true;
  };
  page.on("request", watch);
  await page.getByTestId("login").click();
  await page.locator("#authenticateWebAuthnButton").click();
  await page.waitForURL(`${origin}/**`);
  await page.getByTestId("whoami").waitFor();
  const s3 = await session();
  expect("3 パスキーでログイン", s3.sub === user && sent.passkey && !sent.password, { sent, sub: s3.sub });
} catch (e) {
  ok = false;
  log("error", { error: String(e).slice(0, 500), url: page.url() });
} finally {
  await browser.close();
}
log("判定", { ok });
process.exit(ok ? 0 : 1);
