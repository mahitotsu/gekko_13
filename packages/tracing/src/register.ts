// トレースの計装（D1-a2 の残り、段 T）。node --import で、アプリより先に読む。OTEL_EXPORTER_OTLP_ENDPOINT がなければ、何もしない。
// 自動の計装で、受けた要求、呼んだ要求（node:http、node:https、fetch）、PostgreSQL の問い合わせをスパンにし、W3C の traceparent を渡す。
// 本文とヘッダーは取らない。URL のクエリは、ここでは消さず、collector が属性ごと消す（認可コードが載るため）。
// 送信は裏で行う。collector に届かなくても、アプリは止めない。トレースは原因を探す道具で、監査の証拠にはしない。
import { createRequire, syncBuiltinESMExports } from "node:module";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME ?? process.env.SERVICE ?? "unknown" }),
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter(), scheduledDelayMillis: 2_000 })],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation(), new PgInstrumentation({ requireParentSpan: true })],
  });
  // 計装は CommonJS の読み込みで当たる。先に読んで当て、組み込みの部品は、ESM の名前つきの import にも写す
  const require = createRequire(import.meta.url);
  require("node:http");
  require("node:https");
  require("pg");
  syncBuiltinESMExports();
}
