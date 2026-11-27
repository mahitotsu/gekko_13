"""待ちと送り直し（段 D の D1-a3）。握手で黙る相手は、握手の待ちで見切って送り直す。保険会社のシステムに届かなければ、
送り直してよい失敗として返す。"""

import asyncio
import json
import ssl
import time

import pytest

from insurer_mcp import app
from insurer_mcp.tls import BeforeTls, HandshakeTimeout, mtls_request


async def test_silent_handshake_is_cut_by_the_handshake_timeout_and_retried(capsys):
    # TCP はつながるが、TLS の握手で何も返さない相手（止まったタスクへ向かった Service Connect の中継と同じ見え方）
    server = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    ctx = ssl.create_default_context()
    started = time.monotonic()
    with pytest.raises(HandshakeTimeout):
        await mtls_request(ctx, "GET", f"https://127.0.0.1:{port}/x", "spiffe://t/svc/x", timeout=5, attempts=2,
                           handshake_timeout=0.2, pre_tls_budget=0)
    assert time.monotonic() - started < 2
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if "call_retry" in line]
    assert [(x["attempt"], x["phase"]) for x in lines] == [(1, "handshake"), (2, "handshake")]
    server.close()


async def test_backend_unreachable_is_returned_as_a_retryable_failure(monkeypatch):
    async def call(method, url, expected, headers, body=b""):
        if url.endswith("/oauth2/token"):
            return 200, json.dumps({"access_token": "token-c"}).encode()
        raise TimeoutError()

    monkeypatch.setattr(app, "_call", call)
    app.VERIFIED.set(("token-b", {"sub": "alice", "act": {"sub": "sales-agent"}, "jti": "j-1"}))
    result = await app._backend("POST", "/applications", {"application": {}})
    assert result["status"] == 503
    assert result["retryable"] is True


async def test_cut_before_tls_is_retried_beyond_attempts_until_the_budget(capsys):
    # 握手の前に切る相手（起こした直後の Service Connect と同じ見え方）。POST でも、回数を超えて、上限の時間まで送り直す（段 S）
    async def cut(reader, writer):
        writer.close()

    server = await asyncio.start_server(cut, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    ctx = ssl.create_default_context()
    started = time.monotonic()
    with pytest.raises(BeforeTls):
        await mtls_request(ctx, "POST", f"https://127.0.0.1:{port}/x", "spiffe://t/svc/x", body=b"x", timeout=5,
                           attempts=2, handshake_timeout=1, pre_tls_budget=2)
    elapsed = time.monotonic() - started
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if "call_retry" in line]
    assert len(lines) > 2
    assert all(x["phase"] == "handshake" for x in lines)
    assert lines[-1]["retried"] is False
    assert 1 < elapsed < 3
    server.close()
