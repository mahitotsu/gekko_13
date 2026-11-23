// 顧客のアプリの配信元（gekko_11 の D-41）。画面と、その設定と、提示の公開鍵を渡す。トークンは BFF が持ち、画面には渡さない。
// 保険会社のシステムが、登録済みの連絡先へ直接送る契約内容を、受信箱の番号ごとに受ける（gekko_11 の P-8、P-14、D-26）。AI を通らない。
// 受け口は、入口のリバースプロキシから届く平文の HTTP（createApp）と、保険会社のシステムだけが SVID の mTLS で呼ぶ受け口（handleNotice）の 2 つに分ける。
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Hono } from "hono";
import { json, mtlsFetch, readBody, type SvidSource } from "../../../packages/spiffe-tls/src/index.ts";
import { addBff } from "./bff.ts";
import { state } from "../../../packages/state/src/index.ts";

export interface Notice {
  customer: string;
  contract: Record<string, unknown>;
}

const backendId = () => `spiffe://${process.env.TRUST_DOMAIN ?? "gekko13.internal"}/svc/insurer-backend`;

/** 受信箱の番号は、端末が作る推測できない値（gekko_11 の D-26）。認可サーバーが受け付ける形と同じに限る。 */
const INBOX = /^[A-Za-z0-9_-]{22,64}$/;

/** 画面に渡す設定。 */
// トークンと、ログインサーバー、営業 AI エージェント、認可サーバーの宛先は、画面に渡さない（BFF が持つ。gekko_11 の D-41）
const config = () => ({
  appOrigin: process.env.APP_ORIGIN,
  rpId: process.env.RP_ID,
  terms: [{ type: "insurance_application", kinds: ["fixed", "lifetime"], maxBenefit: 1_200_000 }],
});

/** 画面のファイル。まとめた app.js は、イメージのビルドで作る。 */
const file = (path: string) => {
  try {
    return readFileSync(new URL(path, import.meta.url), "utf8");
  } catch {
    return undefined;
  }
};

/** 提示の公開鍵を、保険会社のシステムから、SVID の mTLS で、相手の SPIFFE ID を確かめて取る。 */
const OFFER_KEYS_URL = process.env.OFFER_KEYS_URL ?? "https://insurer-backend:9443/offers-jwks.json";
let offerKeys: { at: number; body: unknown } | undefined;

/**
 * 保険会社のシステムが、契約内容を直接送る受け口（SVID の mTLS で受ける。main.ts）。送り手は、相手の SPIFFE ID で保険会社のシステムに限る。
 */
export async function handleNotice(req: IncomingMessage, res: ServerResponse, peerId: string) {
  const m = /^\/notices\/([^/?]+)$/.exec(req.url ?? "");
  if (req.method !== "POST" || !m) return json(res, 404, { error: "not_found" });
  if (peerId !== backendId()) return json(res, 403, { error: "保険会社のシステムからの通知ではない" });
  const inbox = m[1];
  if (!INBOX.test(inbox)) return json(res, 400, { error: "受信箱の番号の形が違う" });
  const notice = JSON.parse(await readBody(req)) as Notice;
  // 受信箱は、共有のデータベースに置く。直送と画面の読み取りは、別のタスクに当たる（段 D の D1-a3。判断 53）
  await state().addNotice(inbox, JSON.stringify(notice));
  res.writeHead(204).end();
}

/**
 * 画面の CSP（gekko_11 の G32、P-18）。画面でコードを動かされたときの第 2 の守りで、XSS をなくすものではない。
 * 読み込むものを配信元のスクリプトとスタイルに限る。つなぐ先を、自分の配信元（BFF）に限る。
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    // 画面がつなぐのは、自分の配信元（BFF）だけ（gekko_11 の D-41）
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function createApp(svids?: SvidSource) {
  const app = new Hono();
  const index = file("../dist/index.html");

  // BFF の受け口（gekko_11 の D-41）。戻り先の /callback は、認可コードがあれば BFF が受け、なければ画面を返す
  addBff(app);
  for (const path of ["/", "/callback"]) app.get(path, (c) => (index ? c.html(index, 200, { "content-security-policy": contentSecurityPolicy() }) : c.notFound()));
  // まとめたスクリプトとスタイル。名前に内容のハッシュが入る
  app.get("/assets/:name{[A-Za-z0-9._-]+}", (c) => {
    const name = c.req.param("name");
    const body = file(`../dist/assets/${name}`);
    if (!body) return c.notFound();
    return c.body(body, 200, { "content-type": name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" });
  });
  app.get("/config.json", (c) => c.json(config()));
  app.get("/offers-jwks.json", async (c) => {
    if (!offerKeys || Date.now() - offerKeys.at > 60_000) {
      const res = svids ? await mtlsFetch(svids, backendId())(OFFER_KEYS_URL).catch(() => undefined) : undefined;
      if (!res?.ok) return c.json({ error: "提示の公開鍵を取れない" }, 502);
      offerKeys = { at: Date.now(), body: await res.json() };
    }
    return c.json(offerKeys.body as object);
  });
  // 顧客の端末の中の受信箱に当たる。画面は、自分の番号で読む。番号は、顧客が passkey と一緒に登録した連絡先で、番号を持つ端末だけが読める
  app.get("/api/inbox/:inbox", async (c) => c.json((await state().notices(c.req.param("inbox"))).map((n) => JSON.parse(n) as Notice)));

  return app;
}
