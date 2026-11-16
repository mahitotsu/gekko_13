// シナリオと入れ替えの試験が当てる先。ローカルと AWS の違いは、ここにだけ置く。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actorTokenSource, exchange } from "../packages/token-check/src/index.ts";

export const SERVICES = ["bff", "transfer", "ledger"] as const;
export type Service = (typeof SERVICES)[number];

export interface Target {
  name: "local" | "aws";
  /**
   * この実行が鍵を持つサービス（乗っ取った役）。
   * ローカルは、ホストのパスから 3 つとも読める。AWS は、--as で決めた 1 つだけ（そのファミリーのタスクとして動き、自分の SVID だけを持つ）。
   */
  roles: readonly Service[];
  /** そのサービスの SVID のディレクトリ。役でないサービスを渡すと誤りにする。 */
  svidDir: (s: Service) => string;
  bffUrl: string;
  ledgerUrl: string;
  /** 利用者のアクセストークンを得る。呼ぶたびに新しいものを返してよい。 */
  userToken: () => Promise<string>;
  /** BFF として交換したトークン（act.client_id が BFF）。BFF が transfer に送るものと同じ形。 */
  bffDelegatedToken: (user: string) => Promise<string>;
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
    roles: SERVICES,
    svidDir: (s) => join(root, "svid", s),
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

/**
 * ECS のサービス probe-<役> のタスクの中で動く。タスク定義は、その役の本物のファミリーの別の版で、
 * 同じタスクの svid-helper が書いた /svid だけを読む。値はタスク定義の環境変数と SSM のパラメーターから来る。
 * 当てる先は Service Connect の名前（例: http://bff:8080）。本物のアプリと同じ経路で呼ぶ。
 */
function aws(as: Service): Target {
  const tokenUrl = need("TOKEN_URL");
  const bff = { tokenUrl, clientId: need("BFF_CLIENT_ID"), clientSecret: need("BFF_CLIENT_SECRET") };
  const actor = actorTokenSource({ ...bff, scope: "internal/actor" });
  const appClient = need("APP_CLIENT_ID");
  const refreshToken = need("USER_REFRESH_TOKEN");
  return {
    name: "aws",
    roles: [as],
    svidDir: (s) => {
      if (s !== as) throw new Error(`${s} の鍵は持たない（このタスクの役は ${as}）`);
      return "/svid";
    },
    fakeCertDir: "/app/fixtures/fake",
    bffUrl: need("BFF_URL"),
    ledgerUrl: need("LEDGER_URL"),
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

const argOf = (argv: string[], name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

export function targetFrom(argv: string[]): Target {
  const name = argOf(argv, "--target") ?? "local";
  if (name === "local") return local();
  if (name === "aws") {
    const as = argOf(argv, "--as");
    if (!SERVICES.includes(as as Service)) throw new Error(`--target aws には --as ${SERVICES.join("|")} が要る: ${as}`);
    return aws(as as Service);
  }
  throw new Error(`--target は local か aws: ${name}`);
}
