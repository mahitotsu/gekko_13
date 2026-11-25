"""トレース（D1-a2 の残り、段 T）。OTEL_EXPORTER_OTLP_ENDPOINT がなければ、何もしない（SDK も読まない）。

- 受け口: ASGI の要求ごとにスパンを作り、traceparent を引き継ぐ。
- 呼ぶ側: tls.py の mTLS の呼び出し 1 回ごとにスパンを作り、traceparent を付ける（送り直しは、別のスパンになる）。
本文とヘッダーは取らない。URL はパスまでで、クエリは入れない。送信は裏で行い、届かなくても、サービスは止めない。
"""

from __future__ import annotations

import contextlib
import os
from collections.abc import Iterator
from typing import Any
from urllib.parse import urlsplit

_tracer: Any = None


def setup() -> None:
    global _tracer
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(resource=Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", "insurer-mcp")}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(), schedule_delay_millis=2000))
    trace.set_tracer_provider(provider)
    _tracer = provider.get_tracer("insurer-mcp")


def middleware(inner: Any) -> Any:
    """受けた要求を、スパンにする。"""
    if _tracer is None:
        return inner
    from opentelemetry.propagate import extract
    from opentelemetry.trace import SpanKind

    async def asgi(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            return await inner(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        method, path = scope["method"], scope["path"]
        with _tracer.start_as_current_span(f"{method} {path}", context=extract(headers), kind=SpanKind.SERVER,
                                           attributes={"http.request.method": method, "url.path": path}) as span:

            async def traced_send(message: dict[str, Any]) -> None:
                if message["type"] == "http.response.start":
                    span.set_attribute("http.response.status_code", message["status"])
                await send(message)

            await inner(scope, receive, traced_send)

    return asgi


@contextlib.contextmanager
def client_span(method: str, url: str, headers: dict[str, str]) -> Iterator[Any]:
    """呼ぶ側の 1 回分のスパン。headers に traceparent を足す。トレースしないときは、何もしない。"""
    if _tracer is None:
        yield None
        return
    from opentelemetry.propagate import inject
    from opentelemetry.trace import SpanKind

    u = urlsplit(url)
    with _tracer.start_as_current_span(f"{method} {u.path}", kind=SpanKind.CLIENT,
                                       attributes={"http.request.method": method, "server.address": u.hostname or "", "url.path": u.path}) as span:
        inject(headers)
        yield span
