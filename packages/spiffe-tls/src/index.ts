// SVID のファイル（spiffe-helper が書く）を使って、mTLS のエンドポイントと呼び出しを作る。
// アプリは自分で mTLS を終える。ECS の bridge モードでは同じタスクのコンテナもネットワークを共有せず、
// プロキシの後ろのアプリが直接届いてしまうため（計画の「mTLS を終える場所」）。
import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpsRequest, createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PeerCertificate, TLSSocket } from "node:tls";
import { join } from "node:path";

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
