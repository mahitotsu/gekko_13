// 段 C の確認用のサービス。CloudFront からインスタンスの上のサービスに届くか（C-1）と、パスキーの RP ID（C-2）を確かめる。
// - 2 つのエンドポイントで受ける。8080 は顧客のアプリの役（app）、8081 はログインサーバーの役（login）。ディストリビューションは /login/* を 8081 へ送る。
// - どのエンドポイント・タスク・AZ で受けたか、CloudFront を通ったかを JSON で返す（/edge-point など、下の画面と API のほかのパス）。
// - login の /login/ でパスキーを登録し、app の /app/ で、ある文書の SHA-256 を challenge にして署名する（段 D の「まとめたハッシュへの署名」の代わり）。
//   資格情報はメモリに置く（タスクは 1 つ）。検証は @simplewebauthn/server が行う。
// - RP ID は、ディストリビューションの既定のドメイン（環境変数 RP_ID）。空なら localhost（ローカルの確かめ用）。
// 平文の HTTP で受ける（CloudFront から VPC の中のインスタンスへは HTTP にする。段 D で見直す）。ECS ではホストポートを固定する。
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { json, readBody } from "../../../packages/spiffe-tls/src/index.ts";
import { log } from "../../_shared/src/env.ts";
import { appPage, loginPage } from "./pages.ts";

const APP_PORT = Number(process.env.APP_PORT ?? process.env.PORT ?? 8080);
const LOGIN_PORT = Number(process.env.LOGIN_PORT ?? 8081);
const RP_ID = process.env.RP_ID || "localhost";
// ブラウザーから見た origin。CloudFront の後ろなら https のディストリビューションのドメイン名。ローカルでは 2 つのエンドポイントが別の origin になる
const ORIGINS = RP_ID === "localhost" ? [`http://localhost:${APP_PORT}`, `http://localhost:${LOGIN_PORT}`] : [`https://${RP_ID}`];
// 署名する文書。段 D では、最終の案と申込みをまとめたハッシュになる
const DOCUMENT = "gekko13 C-2: 申込みの内容（試し）";
const DOCUMENT_HASH = createHash("sha256").update(DOCUMENT, "utf8").digest();

type Listener = "app" | "login";

/** ECS のタスクのメタデータ（エンドポイント v4）から、タスクの ID と AZ を読む。ECS の外では空にする。 */
async function taskInfo(): Promise<{ task?: string; az?: string }> {
  const base = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!base) return {};
  try {
    const r = (await (await fetch(`${base}/task`)).json()) as { TaskARN?: string; AvailabilityZone?: string };
    return { task: r.TaskARN?.split("/").pop(), az: r.AvailabilityZone };
  } catch {
    return {};
  }
}

const me = await taskInfo();
const credentials = new Map<string, WebAuthnCredential>();
// 登録と署名の途中の challenge。画面が options を受け取ってから verify を送るまでの間だけ持つ
const pending = new Map<string, { challenge: string; at: number }>();
const remember = (challenge: string) => {
  const flow = randomUUID();
  pending.set(flow, { challenge, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 5 * 60_000) pending.delete(k);
  return flow;
};
const take = (flow: unknown) => {
  const p = typeof flow === "string" ? pending.get(flow) : undefined;
  if (typeof flow === "string") pending.delete(flow);
  return p?.challenge;
};

const html = (res: ServerResponse, body: string) =>
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
}

/** C2-1: ログインサーバーの役で、パスキーを登録する。 */
async function login(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (req.method === "GET" && (path === "/login/" || path === "/login")) {
    html(res, loginPage());
    return true;
  }
  if (req.method === "POST" && path === "/login/api/register/options") {
    const b = await body(req);
    // C2-4: わざと RP ID を公開の接尾辞（cloudfront.net）にする。ブラウザーが拒むはず
    const rpID = b.suffix === true ? RP_ID.split(".").slice(1).join(".") : RP_ID;
    const options = await generateRegistrationOptions({
      rpName: "gekko13",
      rpID,
      userName: `demo-${randomUUID().slice(0, 8)}`,
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      excludeCredentials: [...credentials.values()].map((c) => ({ id: c.id, transports: c.transports })),
    });
    json(res, 200, { flow: remember(options.challenge), options });
    return true;
  }
  if (req.method === "POST" && path === "/login/api/register/verify") {
    const b = await body(req);
    const expectedChallenge = take(b.flow);
    if (!expectedChallenge) return void json(res, 400, { verified: false, error: "unknown_flow" }), true;
    try {
      const v = await verifyRegistrationResponse({
        response: b.response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
        expectedChallenge,
        expectedOrigin: ORIGINS,
        expectedRPID: RP_ID,
        requireUserVerification: true,
      });
      if (v.verified && v.registrationInfo) {
        const c = v.registrationInfo.credential;
        credentials.set(c.id, c);
        const result = {
          verified: true,
          rp_id: RP_ID,
          origin: v.registrationInfo.origin,
          rp_id_of_response: v.registrationInfo.rpID ?? RP_ID,
          device_type: v.registrationInfo.credentialDeviceType,
          backed_up: v.registrationInfo.credentialBackedUp,
          user_verified: v.registrationInfo.userVerified,
          credentials: credentials.size,
        };
        log({ event: "passkey_registered", ...result, browser: b.browser });
        return void json(res, 200, result), true;
      }
      json(res, 400, { verified: false });
    } catch (e) {
      log({ event: "passkey_register_failed", error: String(e), browser: b.browser });
      json(res, 400, { verified: false, error: String(e) });
    }
    return true;
  }
  if (req.method === "POST" && path === "/login/api/register/client-error") {
    // C2-4 などで、ブラウザーが拒んだときの理由を残す
    const b = await body(req);
    log({ event: "passkey_client_error", case: b.case, name: b.name, message: b.message, browser: b.browser });
    json(res, 200, { logged: true });
    return true;
  }
  return false;
}

/** C2-2: 顧客のアプリの役で、文書のハッシュに署名する。 */
async function app(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (req.method === "GET" && (path === "/app/" || path === "/app")) {
    html(res, appPage(DOCUMENT, DOCUMENT_HASH.toString("base64url")));
    return true;
  }
  if (req.method === "POST" && path === "/app/api/sign/options") {
    if (credentials.size === 0) return void json(res, 409, { error: "no_credential", hint: "/login/ で先に登録する" }), true;
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      challenge: new Uint8Array(DOCUMENT_HASH),
      userVerification: "required",
      allowCredentials: [...credentials.values()].map((c) => ({ id: c.id, transports: c.transports })),
    });
    json(res, 200, { flow: remember(options.challenge), options });
    return true;
  }
  if (req.method === "POST" && path === "/app/api/sign/verify") {
    const b = await body(req);
    const expectedChallenge = take(b.flow);
    const response = b.response as Parameters<typeof verifyAuthenticationResponse>[0]["response"] | undefined;
    const credential = response ? credentials.get(response.id) : undefined;
    if (!expectedChallenge || !credential) return void json(res, 400, { verified: false, error: "unknown_flow_or_credential" }), true;
    try {
      const v = await verifyAuthenticationResponse({
        response: response!,
        expectedChallenge,
        expectedOrigin: ORIGINS,
        expectedRPID: RP_ID,
        credential,
        requireUserVerification: true,
      });
      // 署名された clientDataJSON の challenge が、文書のハッシュそのものかを確かめる
      const clientData = JSON.parse(Buffer.from(response!.response.clientDataJSON, "base64url").toString("utf8")) as { challenge: string };
      const result = {
        verified: v.verified,
        rp_id: RP_ID,
        origin: v.authenticationInfo.origin,
        challenge_is_document_hash: clientData.challenge === DOCUMENT_HASH.toString("base64url"),
        document_hash: DOCUMENT_HASH.toString("base64url"),
        user_verified: v.authenticationInfo.userVerified,
        new_counter: v.authenticationInfo.newCounter,
      };
      if (v.verified) credential.counter = v.authenticationInfo.newCounter;
      log({ event: "passkey_signed", ...result, browser: b.browser });
      json(res, v.verified ? 200 : 400, result);
    } catch (e) {
      log({ event: "passkey_sign_failed", error: String(e), browser: b.browser });
      json(res, 400, { verified: false, error: String(e) });
    }
    return true;
  }
  return false;
}

function serve(listener: Listener, port: number) {
  createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const viaCloudFront = typeof req.headers["x-amz-cf-id"] === "string";
    log({ event: "request", listener, method: req.method, path, via_cloudfront: viaCloudFront, remote: req.socket.remoteAddress });
    try {
      if (listener === "login" && (await login(req, res, path))) return;
      if (listener === "app" && (await app(req, res, path))) return;
    } catch (e) {
      log({ event: "handler_error", error: String(e) });
      if (!res.headersSent) return void json(res, 500, { error: "internal" });
    }
    json(res, 200, {
      service: "edge-check",
      listener,
      path: req.url,
      task: me.task ?? null,
      az: me.az ?? null,
      container: hostname(),
      via_cloudfront: viaCloudFront,
      via: req.headers.via ?? null,
      remote: req.socket.remoteAddress ?? null,
    });
  }).listen(port, "::", () => log({ event: "listening", listener, port, rp_id: RP_ID }));
}

serve("app", APP_PORT);
serve("login", LOGIN_PORT);
