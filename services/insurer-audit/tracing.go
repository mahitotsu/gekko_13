package main

// トレース（D1-a2 の残り、段 T）。OTEL_EXPORTER_OTLP_ENDPOINT がなければ、何もしない。
// 本文とヘッダーは取らない。送信は裏で行い、届かなくても、サービスは止めない。監査の証拠にはしない。

import (
	"context"
	"net/http"
	"os"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func tracingOn() bool { return os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" }

func setupTracing(ctx context.Context) error {
	if !tracingOn() {
		return nil
	}
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return err
	}
	otel.SetTracerProvider(sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter, sdktrace.WithBatchTimeout(2*time.Second)),
		sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", env("OTEL_SERVICE_NAME", "insurer-audit")))),
	))
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return nil
}

// traceHandler は、受けた要求をスパンにする。
func traceHandler(next http.Handler) http.Handler {
	if !tracingOn() {
		return next
	}
	return otelhttp.NewHandler(next, "insurer-audit")
}

// traceTransport は、呼ぶ要求をスパンにし、traceparent を付ける。
func traceTransport(next http.RoundTripper) http.RoundTripper {
	if !tracingOn() {
		return next
	}
	return otelhttp.NewTransport(next)
}
