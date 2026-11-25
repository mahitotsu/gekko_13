// 入口のトレース（段 T）。依存のパッケージは使わず、OTLP の JSON を、インスタンスの collector へ HTTP で送る。
// Web Functions には X-Ray の設定がなく、VPC の外へも出ないので、送り先と同じく、名前空間の SRV で collector を見つけて送る。
// - 入口はトレースの始まりにする。閲覧者が送った traceparent と tracestate は捨て、自分の値を送り先に渡す（偽れないようにする）。
// - 本文、ヘッダー、クエリは取らない。パスと状態だけにする。
// - 送るのは応答のあとの裏で、失敗しても捨てる。リクエストの処理は止めない。実行環境が止まっている間は、次に動くまで届かないことがある。
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Resolver } from "./proxy.ts";

type Attrs = Record<string, string | number>;
export type Span = { traceparent: string; end(attrs?: Attrs, failed?: boolean): void };
export type RootSpan = Span & { child(name: string, attrs: Attrs): Span };
export interface Tracer {
  start(name: string, attrs: Attrs): RootSpan;
}

export type ExportedSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: 2 | 3; startMs: number; endMs: number; attrs: Attrs; failed: boolean };

export function createTracer(send: (spans: ExportedSpan[]) => void): Tracer {
  const id = (n: number) => randomBytes(n).toString("hex");
  return {
    start(rootName, rootAttrs) {
      const traceId = id(16);
      const spans: ExportedSpan[] = [];
      const open = (name: string, kind: 2 | 3, attrs: Attrs, parentSpanId: string | undefined, done: () => void): Span & { spanId: string } => {
        const spanId = id(8);
        const startMs = Date.now();
        let ended = false;
        return {
          spanId,
          traceparent: `00-${traceId}-${spanId}-01`,
          end(more = {}, failed = false) {
            if (ended) return;
            ended = true;
            spans.push({ traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), name, kind, startMs, endMs: Date.now(), attrs: { ...attrs, ...more }, failed });
            done();
          },
        };
      };
      // 根のスパンが終わったら、まとめて送る
      const root = open(rootName, 2, rootAttrs, undefined, () => send(spans));
      return { ...root, child: (name, attrs) => open(name, 3, attrs, root.spanId, () => {}) };
    },
  };
}

/** OTLP の JSON にする。 */
export function otlp(spans: ExportedSpan[]): string {
  const ns = (ms: number) => `${ms}000000`;
  const value = (v: string | number) => (typeof v === "number" ? { intValue: String(v) } : { stringValue: v });
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "entry" } }] },
        scopeSpans: [
          {
            scope: { name: "entry" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: ns(s.startMs),
              endTimeUnixNano: ns(s.endMs),
              attributes: Object.entries(s.attrs).map(([key, v]) => ({ key, value: value(v) })),
              ...(s.failed ? { status: { code: 2 } } : {}),
            })),
          },
        ],
      },
    ],
  });
}

/** SRV で見つけた collector へ送る。collector がいなければ（0 台など）、捨てる。 */
export function collectorSender(service: string, resolver: Resolver, timeoutMs = 1_000): (spans: ExportedSpan[]) => void {
  return (spans) => {
    void (async () => {
      const targets = await resolver.resolve(service);
      const t = targets[Math.floor(Math.random() * targets.length)];
      if (!t) return;
      const body = otlp(spans);
      const req = request({ host: t.host, port: t.port, method: "POST", path: "/v1/traces", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, agent: false }, (res) => res.resume());
      req.setTimeout(timeoutMs, () => req.destroy());
      req.on("error", () => resolver.failed(service));
      req.end(body);
    })().catch(() => undefined);
  };
}
