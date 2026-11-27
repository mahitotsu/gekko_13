// SVID のファイル（spiffe-helper が書く）を使って、mTLS のエンドポイントと呼び出しを作る。
// アプリは自分で mTLS を終える。ECS の bridge モードでは同じタスクのコンテナもネットワークを共有せず、
// プロキシの後ろのアプリが直接届いてしまうため（計画の「mTLS を終える場所」）。
import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpsRequest, createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PeerCertificate, TLSSocket } from "node:tls";
import { join } from "node:path";
import { Readable } from "node:stream";

export interface Svid {
  cert: string;
  key: string;
  bundle: string;
  /** 自分の SPIFFE ID（証明書の SAN の URI）。 */
  id: string;
  /** 証明書の有効期限（ISO 8601）。入れ替えの記録に使う。 */
  notAfter: string;
  serial: string;
}

const SAN_URI = /(?:^|,\s*)URI:(spiffe:\/\/[^,\s]+)/g;

/** 証明書の SAN から SPIFFE ID を取り出す。SPIFFE の X.509-SVID は URI の SAN をちょうど 1 つ持つ。 */
export function spiffeIdOf(subjectaltname: string | undefined): string | undefined {
  if (!subjectaltname) return undefined;
  const ids = [...subjectaltname.matchAll(SAN_URI)].map((m) => m[1]);
  return ids.length === 1 ? ids[0] : undefined;
}

/** 相手の証明書から SPIFFE ID を取り出す。証明書がないか、検証に通っていなければ undefined。 */
export function peerIdOf(req: IncomingMessage): string | undefined {
  const socket = req.socket as TLSSocket;
  if (!socket.authorized) return undefined;
  const cert: PeerCertificate = socket.getPeerCertificate();
  return spiffeIdOf(cert?.subjectaltname);
}

/** 相手の証明書の x5t#S256（RFC 8705。DER の SHA-256 の base64url）。トークンの cnf と照らす。 */
export function peerX5tS256(req: IncomingMessage): string | undefined {
  const socket = req.socket as TLSSocket;
  if (!socket.authorized) return undefined;
  const raw = socket.getPeerCertificate()?.raw;
  return raw ? createHash("sha256").update(raw).digest("base64url") : undefined;
}

async function readSvid(dir: string): Promise<Svid> {
  const [cert, key, bundle] = await Promise.all(
    ["svid.pem", "svid_key.pem", "svid_bundle.pem"].map((f) => readFile(join(dir, f), "utf8")),
  );
  // svid.pem は葉の証明書から始まる。中間の証明書が続くことがある
  const leaf = new X509Certificate(cert);
  const id = spiffeIdOf(leaf.subjectAltName);
  if (!id) throw new Error(`SVID に SPIFFE ID がない: ${dir}`);
  return { cert, key, bundle, id, notAfter: new Date(leaf.validTo).toISOString(), serial: leaf.serialNumber };
}

const digest = (s: Svid) => createHash("sha256").update(s.cert).update(s.key).update(s.bundle).digest("hex");

/**
 * SVID のファイルを読み、入れ替わったら知らせる。
 * spiffe-helper はファイルを書き換えて入れ替える。fs.watch はボリュームの種類で届かないことがあるので、定期的に読む。
 */
export class SvidSource {
  readonly dir: string;
  #current: Svid | undefined;
  #hash = "";
  #listeners: ((s: Svid) => void)[] = [];
  #timer: NodeJS.Timeout | undefined;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 最初の SVID が届くまで待つ。spiffe-helper が書く前にアプリが起動することがある。 */
  async start(intervalMs = 2000, timeoutMs = 120_000): Promise<Svid> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.#poll();
        break;
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    this.#timer = setInterval(() => this.#poll().catch(() => {}), intervalMs);
    this.#timer.unref();
    return this.current;
  }

  stop() {
    clearInterval(this.#timer);
  }

  get current(): Svid {
    if (!this.#current) throw new Error("SVID をまだ読んでいない");
    return this.#current;
  }

  onChange(f: (s: Svid) => void) {
    this.#listeners.push(f);
  }

  async #poll() {
    const s = await readSvid(this.dir);
    const h = digest(s);
    if (h === this.#hash) return;
    const first = this.#hash === "";
    this.#current = s;
    this.#hash = h;
    if (!first) for (const f of this.#listeners) f(s);
  }
}

export type Handler = (req: IncomingMessage, res: ServerResponse, peerId: string) => unknown;

/**
 * クライアント証明書を必ず求める HTTPS のエンドポイント。信頼するのは SPIRE のバンドルだけ。
 * SVID が入れ替わったら setSecureContext で差し替える。差し替えは、新しい接続から効く。
 */
export function createMtlsServer(source: SvidSource, handler: Handler, log: (o: object) => void = () => {}): Server {
  const ctx = (s: Svid) => ({ cert: s.cert, key: s.key, ca: s.bundle });
  const server = createServer(
    { ...ctx(source.current), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" },
    async (req, res) => {
      const peerId = peerIdOf(req);
      if (!peerId) {
        // rejectUnauthorized で、ここには検証に通った証明書の接続しか来ない。SPIFFE ID のない証明書だけが残る
        res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "no_spiffe_id" }));
        return;
      }
      try {
        await handler(req, res, peerId);
      } catch (e) {
        log({ at: new Date().toISOString(), event: "handler_error", error: String(e) });
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    },
  );
  source.onChange((s) => {
    server.setSecureContext(ctx(s));
    log({ at: new Date().toISOString(), event: "svid_rotated", id: s.id, serial: s.serial, notAfter: s.notAfter });
  });
  return server;
}

export interface CallResult {
  status: number;
  body: string;
}

/**
 * 相手の SPIFFE ID を確かめて、そのときの SVID で mTLS をかけて呼ぶ。
 * 接続はリクエストごとにつなぎ直す（agent: false）。使い回すと、入れ替わる前の証明書で示し続ける（gekko_11 の F-G54）。
 */
export function mtlsCall(
  svid: Pick<Svid, "cert" | "key" | "bundle">,
  url: string,
  expectedServerId: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: init.method ?? "GET",
        headers: init.headers,
        // 空なら証明書を示さない（シナリオ 3-b で使う）
        cert: svid.cert || undefined,
        key: svid.key || undefined,
        ca: svid.bundle,
        agent: false,
        minVersion: "TLSv1.3",
        // SVID には DNS の SAN がないので、ホスト名ではなく SPIFFE ID で相手を確かめる
        checkServerIdentity: (_host, cert) => {
          const id = spiffeIdOf(cert.subjectaltname);
          return id === expectedServerId ? undefined : new Error(`相手の SPIFFE ID が違う: ${id ?? "(なし)"}`);
        },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(init.body);
  });
}

/** 応答が届く前に、つなぎが切れたときの誤り。送り直してよい（段 D の D1-a3）。 */
const RETRYABLE = new Set(["ECONNRESET", "EPIPE", "ECONNREFUSED", "ECONNABORTED", "EHANDSHAKETIMEOUT"]);
export const isRetryable = (e: unknown) => {
  const err = e as NodeJS.ErrnoException;
  return RETRYABLE.has(err.code ?? "") || /socket disconnected before secure TLS|socket hang up/.test(err.message ?? "");
};

/**
 * mtlsCall と同じく、相手の SPIFFE ID を確かめて、そのときの SVID で mTLS をかけて呼ぶ。応答の本文は流したまま返す（AG-UI の SSE を中継するため）。
 * fetch の形で返すので、openid-client や jose の customFetch にも渡せる。
 * 応答が届く前につなぎが切れたら、最大 6 回まで、間を 0.3 秒ずつ延ばして送り直す（合わせて約 4.5 秒。段 D の D1-a3）。Service Connect の
 * 外れ値の検出が、止まったタスクを避けるまで続ける（外れ値の検出は、直近 30 秒に 5 回以上失敗したタスクを避ける。ECS の資料。3 回では避けられる前に送り終えた。2026-11-23 の AWS）。止まったタスクへのつなぎを、Service Connect は救いきれなかった
 * （2026-11-23 の AWS）。送り直しは、つなぐたびに Service Connect が送り先を選び直す。POST も送り直すが、受ける側は 2 度届いても困らない
 * （営業 AI エージェントの回は、同じ答えの 2 度目を 409 で拒む。申込みは nonce が 1 回しか通さない。交換は、トークンがもう 1 つ出るだけ）。
 * 相手の SPIFFE ID が違う、時間切れ、取りやめ、応答が始まったあとの失敗は、送り直さない。
 * TLS の握手が終わる前の失敗（まだ 1 バイトも送っていない）は、回数に依らず、最初から合わせて preTlsBudgetMs（既定 10 秒）まで送り直す
 * （段 S。0 台から起こした直後は、相手が Service Connect の送り先になるまで、つなぎが握手の前に切られ、0.9〜4.5 秒の送り直しが尽きていた。
 * findings 5-36）。2 度届くことはない。
 */
export function mtlsFetch(source: SvidSource, expectedServerId: string, timeoutMs = 30_000, attempts = 6, handshakeTimeoutMs = 3_000, preTlsBudgetMs = 10_000): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)));
    const body = init.body === undefined || init.body === null ? undefined : init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
    const once = () =>
      new Promise<Response>((resolve, reject) => {
        const svid = source.current;
        // TLS の握手が終わったか。終わる前の失敗は、まだ何も送っていない
        let secured = false;
        const req = httpsRequest(
          url,
          {
            method: init.method ?? "GET",
            headers,
            cert: svid.cert,
            key: svid.key,
            ca: svid.bundle,
            agent: false,
            minVersion: "TLSv1.3",
            checkServerIdentity: (_host, cert) => {
              const id = spiffeIdOf(cert.subjectaltname);
              return id === expectedServerId ? undefined : new Error(`相手の SPIFFE ID が違う: ${id ?? "(なし)"}`);
            },
            timeout: timeoutMs,
          },
          (res) => {
            const out = new Headers();
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : v);
            const status = res.statusCode ?? 502;
            // 応答が始まったら、待ちの上限を外す（SSE は長く続く）
            req.setTimeout(0);
            resolve(new Response(status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: out }));
          },
        );
        // 握手の待ち（段 D の D1-a3）。Service Connect は TCP の中継なので、止まったタスクへ向かったつなぎは、TCP はつながっても握手で黙る。
        // 握手が終わる前なら、まだ何も送っていないので、見切って送り直してよい（つなぎ直すと、Service Connect が送り先を選び直す）
        req.on("socket", (s) => {
          const timer = setTimeout(
            () => req.destroy(Object.assign(new Error(`握手が ${handshakeTimeoutMs} ms で終わらなかった`), { code: "EHANDSHAKETIMEOUT" })),
            handshakeTimeoutMs,
          );
          s.once("secureConnect", () => {
            secured = true;
            clearTimeout(timer);
          });
          s.once("close", () => clearTimeout(timer));
        });
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", (e) => reject(Object.assign(e, { beforeTls: !secured })));
        init.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")));
        req.end(body);
      });
    const started = Date.now();
    for (let i = 1; ; i++) {
      const t0 = Date.now();
      try {
        return await once();
      } catch (e) {
        const beforeTls = (e as { beforeTls?: boolean }).beforeTls === true;
        const wait = Math.min(300 * i, 1_000);
        const retried =
          !init.signal?.aborted && isRetryable(e) && (i < attempts || (beforeTls && Date.now() - started + wait < preTlsBudgetMs));
        // 送り直しと時間切れを、段と経過の秒つきで残す（どの呼び出しの、どの段で待ったかを、あとで読むため）
        if (!init.signal?.aborted) {
          const code = (e as NodeJS.ErrnoException).code;
          console.log(JSON.stringify({ at: new Date().toISOString(), ev: "call_retry", url: url.origin + url.pathname, attempt: i, phase: code === "EHANDSHAKETIMEOUT" || beforeTls ? "handshake" : "response", error: code ?? (e as Error).message, retried, ms: Date.now() - t0, totalMs: Date.now() - started }));
        }
        if (!retried) throw e;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }) as typeof fetch;
}

export async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
