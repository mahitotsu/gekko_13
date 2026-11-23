// 顧客のアプリ（画面の配信元と BFF）を起動する（段 D の D1-a2）。受け口は 2 つ。
// - APP_PORT（既定 8080）: 入口のリバースプロキシから届く平文の HTTP。画面、BFF、受信箱の読み取り
// - NOTICE_PORT（既定 9443）: 保険会社のシステムが、契約内容を直接送る受け口。SVID の mTLS で受け、相手の SPIFFE ID を確かめる
// SVID は spiffe-helper が SVID_DIR に書く。BFF は、同じ SVID で、営業 AI エージェントと認可サーバーを mTLS で呼ぶ。
// セッションと受信箱は、共有のデータベースに置く（段 D の D1-a3。state.ts）。DB_URL と STATE_KEY がなければ、起動しない。
import { serve } from "@hono/node-server";
import { createMtlsServer, SvidSource } from "../../../packages/spiffe-tls/src/index.ts";
import { createApp, handleNotice } from "./app.ts";
import { useSvids } from "./bff.ts";
import { pgState, useState } from "./state.ts";

const log = (o: object) => console.log(JSON.stringify({ at: new Date().toISOString(), svc: "customer-app", ...o }));

const svids = new SvidSource(process.env.SVID_DIR ?? "/svid");
const first = await svids.start();
log({ ev: "svid", id: first.id, notAfter: first.notAfter });
useSvids(svids);
useState(await pgState());
log({ ev: "state", store: "postgres" });

const appPort = Number(process.env.APP_PORT ?? 8080);
serve({ fetch: createApp(svids).fetch, hostname: "0.0.0.0", port: appPort }, () => log({ ev: "listening", port: appPort }));

const noticePort = Number(process.env.NOTICE_PORT ?? 9443);
createMtlsServer(svids, handleNotice, log).listen(noticePort, "0.0.0.0", () => log({ ev: "listening", port: noticePort, mtls: true }));
