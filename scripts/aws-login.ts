// AWS の段: マネージドログインでログインし、利用者のリフレッシュトークンを SSM の SecureString に置く。
// プローブ（ECS のサービス probe-bff、probe-transfer、probe-ledger）は、そこからアクセストークンを得る。トークンは画面にもファイルにも出さない。
// 使い方: node scripts/aws-login.ts   （表示した URL をブラウザで開き、aws/create-user.sh で作った利用者でログインする）
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

const REGION = process.env.AWS_REGION ?? "ap-northeast-1";
const PREFIX = "gekko13";
const PARAMETER = `/${PREFIX}/probe/refresh-token`;
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;

const out = (key: string) =>
  execFileSync("aws", ["cloudformation", "describe-stacks", "--region", REGION, "--stack-name", `${PREFIX}-cognito`,
    "--query", `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`, "--output", "text"], { encoding: "utf8" }).trim();

const authorizeUrl = out("AuthorizeUrl");
const tokenUrl = out("TokenUrl");
const clientId = out("AppClientId");

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("base64url");

const url = new URL(authorizeUrl);
url.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  scope: "openid banking/view banking/transfer",
  code_challenge: challenge,
  code_challenge_method: "S256",
  state,
}).toString();

async function handle(req: IncomingMessage, res: ServerResponse) {
  const u = new URL(req.url ?? "/", REDIRECT);
  if (u.pathname !== "/callback") return res.writeHead(404).end();
  if (u.searchParams.get("state") !== state || !u.searchParams.get("code")) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("state が一致しないか、code がない");
    return;
  }
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: u.searchParams.get("code")!, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  const body = (await r.json()) as { refresh_token?: string; error?: string };
  if (!r.ok || !body.refresh_token) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`トークンを得られない: ${body.error ?? r.status}`);
    console.error(`トークンを得られない: ${r.status} ${body.error ?? ""}`);
    process.exit(1);
  }
  // 値はコマンドの引数に載せない（プロセスの一覧に出さない）。AWS CLI 2.38.1 は、子プロセスの標準入力の
  // file:///dev/stdin を開けない（docs/findings.md）。メモリの上（/dev/shm）の、本人だけが読める一時ファイルを使い、すぐに消す
  const dir = mkdtempSync(join("/dev/shm", "gekko13-login-"));
  const file = join(dir, "refresh-token");
  try {
    writeFileSync(file, body.refresh_token, { mode: 0o600 });
    execFileSync("aws", ["ssm", "put-parameter", "--region", REGION, "--name", PARAMETER, "--type", "SecureString", "--overwrite", "--value", `file://${file}`], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ログインした。このタブは閉じてよい。");
  console.log(`リフレッシュトークンを ${PARAMETER} に置いた。有効期限は 60 分（aws/cognito.yaml）。`);
  process.exit(0);
}

// localhost が IPv4 と IPv6 のどちらに解決されても受けられるよう、両方のループバックで待つ
for (const host of ["127.0.0.1", "::1"]) {
  createServer((req, res) => void handle(req, res)).on("error", () => {}).listen(PORT, host);
}
console.log(`次の URL をブラウザで開いてログインする:\n${url}`);
setTimeout(() => {
  console.error("5 分のうちにログインされなかった");
  process.exit(1);
}, 5 * 60_000).unref();
