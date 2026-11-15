// シナリオと入れ替えの試験が当てる先。ローカルと AWS の違いは、ここにだけ置く。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actorTokenSource, exchange } from "../packages/token-check/src/index.ts";

export interface Target {
  name: "local" | "aws";
  /** 各サービスの SVID のディレクトリ（<svidRoot>/<サービス名>/）。 */
  svidRoot: string;
  bffUrl: string;
  ledgerUrl: string;
  /** 利用者のアクセストークンを得る。呼ぶたびに新しいものを返してよい。 */
  userToken: () => Promise<string>;
  /** BFF として交換したトークン（act.client_id が BFF）。BFF が transfer に送るものと同じ形。 */
  bffDelegatedToken: (user: string) => Promise<string>;
  /** AWS: 登録していないファミリーの svid-helper が書く先。 */
  rogueDir?: string;
  /** AWS: イメージに入れた偽の証明書。ローカルではその場で作る。 */
  fakeCertDir?: string;
  /** 結果の JSON を書く先。AWS ではログから拾うので書かない。 */
  outDir?: string;
}

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} がない`);
  return v;
};

function local(): Target {
  const root = new URL("../local/run/", import.meta.url).pathname;
  const issuer = "http://127.0.0.1:19000";
  const env = Object.fromEntries(
    readFileSync(join(root, "bff.env"), "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const bff = { tokenUrl: `${issuer}/oauth2/token`, clientId: env.CLIENT_ID, clientSecret: env.CLIENT_SECRET };
  const actor = actorTokenSource({ ...bff, scope: "internal/actor" });
  return {
    name: "local",
    svidRoot: join(root, "svid"),
    bffUrl: "http://127.0.0.1:18080",
    ledgerUrl: "https://127.0.0.1:28443",
    outDir: root,
    userToken: async () => {
      const r = await fetch(`${issuer}/test/login`, { method: "POST", body: JSON.stringify({ sub: "demo-user", scope: "banking/view banking/transfer" }) });
      return ((await r.json()) as { access_token: string }).access_token;
    },
    bffDelegatedToken: async (user) => exchange({ ...bff, subjectToken: user, actorToken: await actor(), scope: "banking/transfer" }),
  };
}

/** ECS のタスク gekko13-probe の中で動く。値はタスク定義の環境変数と SSM の SecureString から来る。 */
function aws(): Target {
  const host = need("HOST_BRIDGE_IP");
  const tokenUrl = need("TOKEN_URL");
  const bff = { tokenUrl, clientId: need("BFF_CLIENT_ID"), clientSecret: need("BFF_CLIENT_SECRET") };
  const actor = actorTokenSource({ ...bff, scope: "internal/actor" });
  const appClient = need("APP_CLIENT_ID");
  const refreshToken = need("USER_REFRESH_TOKEN");
  return {
    name: "aws",
    svidRoot: "/svid-all",
    rogueDir: "/svid-rogue",
    fakeCertDir: "/app/fixtures/fake",
    bffUrl: `http://${host}:18080`,
    ledgerUrl: `https://${host}:28443`,
    // マネージドログインで得たリフレッシュトークンから、アクセストークンを得る。交換元にできるのはこの形だけ（gekko_12 の実測 1-1）
    userToken: async () => {
      const r = await fetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: appClient, refresh_token: refreshToken }),
      });
      const body = (await r.json()) as { access_token?: string; error?: string };
      if (!r.ok || !body.access_token) throw new Error(`利用者のトークンを得られない: ${r.status} ${body.error ?? ""}`);
      return body.access_token;
    },
    bffDelegatedToken: async (user) => exchange({ ...bff, subjectToken: user, actorToken: await actor(), scope: "banking/transfer" }),
  };
}

export function targetFrom(argv: string[]): Target {
  const i = argv.indexOf("--target");
  const name = i >= 0 ? argv[i + 1] : "local";
  if (name === "local") return local();
  if (name === "aws") return aws();
  throw new Error(`--target は local か aws: ${name}`);
}
