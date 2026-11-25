"""トレース: 送り先がなければ何もしない。あれば、受けた traceparent を引き継ぎ、呼ぶ側に付ける。"""

import asyncio

from insurer_mcp import tracing


def test_off_by_default():
    inner = object()
    assert tracing.middleware(inner) is inner
    headers: dict[str, str] = {}
    with tracing.client_span("GET", "https://x/y", headers) as span:
        assert span is None
    assert headers == {}


def test_continues_trace(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
    monkeypatch.setattr(tracing, "_tracer", None)
    tracing.setup()
    out: dict[str, str] = {}

    async def inner(scope, receive, send):
        with tracing.client_span("POST", "https://insurer-backend:9443/offers?code=secret", out) as span:
            assert "secret" not in str(span.attributes)
        await send({"type": "http.response.start", "status": 200, "headers": []})

    async def send(message):
        pass

    trace_id = "ab" * 16
    scope = {"type": "http", "method": "POST", "path": "/mcp", "headers": [(b"traceparent", f"00-{trace_id}-{'cd' * 8}-01".encode())]}
    asyncio.run(tracing.middleware(inner)(scope, None, send))
    assert out["traceparent"].split("-")[1] == trace_id
