"""SVID（spiffe-helper が書くファイル）で、mTLS を受け、また呼ぶ（段 D の D1-a2-2）。

- 受け口: uvicorn の TLS で、相手の証明書を必ず求める。uvicorn は相手の証明書を ASGI に渡さないので、接続ができたときに
  相手の証明書（DER）を、相手のアドレスをキーに控える（PeerCertProtocol）。受け口は scope["client"] でそれを引く。
- 入れ替え: spiffe-helper はファイルを書き換えて入れ替える。同じ SSLContext に読み直させる（新しい接続から効く）。
- 呼ぶ側: 相手の SPIFFE ID を確かめる。SVID には DNS の SAN がないので、名前ではなく SPIFFE ID で確かめる。
"""

from __future__ import annotations

import base64
import hashlib
import os
import ssl
import threading
import time
from typing import Any

from cryptography import x509
from uvicorn.protocols.http.h11_impl import H11Protocol

from insurer_mcp import tracing

#: 相手のアドレス（host, port）ごとの、相手の証明書（DER）
PEER_CERTS: dict[tuple[str, int], bytes] = {}


class PeerCertProtocol(H11Protocol):
    """接続ができたときに、相手の証明書を控える。"""

    def connection_made(self, transport: Any) -> None:  # type: ignore[override]
        super().connection_made(transport)
        ssl_object = transport.get_extra_info("ssl_object")
        peer = transport.get_extra_info("peername")
        if ssl_object is not None and peer:
            der = ssl_object.getpeercert(binary_form=True)
            if der:
                PEER_CERTS[(peer[0], peer[1])] = der

    def connection_lost(self, exc: Exception | None) -> None:
        peer = self.transport.get_extra_info("peername") if self.transport else None
        if peer:
            PEER_CERTS.pop((peer[0], peer[1]), None)
        super().connection_lost(exc)


def spiffe_id_of(der: bytes) -> str | None:
    """証明書の SAN の URI から SPIFFE ID を取り出す。ちょうど 1 つのときだけ返す。"""
    cert = x509.load_der_x509_certificate(der)
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return None
    uris = [u for u in san.get_values_for_type(x509.UniformResourceIdentifier) if u.startswith("spiffe://")]
    return uris[0] if len(uris) == 1 else None


def x5t_s256(der: bytes) -> str:
    """RFC 8705 の x5t#S256（DER の SHA-256 の base64url）。"""
    return base64.urlsafe_b64encode(hashlib.sha256(der).digest()).rstrip(b"=").decode()


class SvidSource:
    """SVID のファイルを読み、受け口と呼ぶ側の SSLContext に読み直させる。"""

    def __init__(self, directory: str):
        self.cert = os.path.join(directory, "svid.pem")
        self.key = os.path.join(directory, "svid_key.pem")
        self.bundle = os.path.join(directory, "svid_bundle.pem")
        self._stamp: tuple[float, float, float] | None = None
        self._contexts: list[ssl.SSLContext] = []

    def wait(self, timeout: float = 120) -> None:
        deadline = time.time() + timeout
        while not all(os.path.exists(p) and os.path.getsize(p) > 0 for p in (self.cert, self.key, self.bundle)):
            if time.time() > deadline:
                raise TimeoutError("SVID のファイルが書かれない")
            time.sleep(1)

    def _load(self, ctx: ssl.SSLContext) -> None:
        ctx.load_cert_chain(self.cert, self.key)
        ctx.load_verify_locations(self.bundle)

    def server_context(self) -> ssl.SSLContext:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_3
        ctx.verify_mode = ssl.CERT_REQUIRED
        self._load(ctx)
        self._contexts.append(ctx)
        return ctx

    def client_context(self) -> ssl.SSLContext:
        """呼ぶ側。名前の確かめは外し、呼んだあとで相手の SPIFFE ID を確かめる（check_peer）。"""
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_3
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_REQUIRED
        self._load(ctx)
        self._contexts.append(ctx)
        return ctx

    def pinned_client_context(self) -> ssl.SSLContext:
        """呼ぶ側の SSLContext を、いまの SVID で作る。入れ替わっても読み直さない（1 回の呼び出しの間、同じ証明書を使い続けるため）。
        交換で受け取るトークンは、そのときの証明書に結ばれるので、交換と次の呼び出しで証明書が食い違うと断られる（段 D の D1-a3）。"""
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_3
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_REQUIRED
        self._load(ctx)
        return ctx

    def watch(self, interval: float = 2) -> None:
        """ファイルが替わったら、作った全部の SSLContext に読み直させる。"""

        def loop() -> None:
            while True:
                try:
                    stamp = tuple(os.path.getmtime(p) for p in (self.cert, self.key, self.bundle))
                    if self._stamp is not None and stamp != self._stamp:
                        for ctx in self._contexts:
                            self._load(ctx)
                        print('{"svc":"insurer-mcp","event":"svid_rotated"}', flush=True)
                    self._stamp = stamp  # type: ignore[assignment]
                except OSError:
                    pass
                time.sleep(interval)

        threading.Thread(target=loop, daemon=True).start()


class Refused(Exception):
    """相手の SPIFFE ID が違う。要求は送っていない。"""


class BeforeTls(ConnectionError):
    """TLS の握手が終わる前に、つなぎが切れた。まだ何も送っていないので、送り直してよい（段 S）。"""


class HandshakeTimeout(TimeoutError):
    """握手（TCP と TLS）が、握手の待ちのうちに終わらなかった。まだ何も送っていないので、送り直してよい。"""


def _log_attempt(**o: Any) -> None:
    import json as _json
    import sys as _sys

    print(_json.dumps({"svc": "insurer-mcp", "event": "call_retry", **o}, ensure_ascii=False), file=_sys.stdout, flush=True)


async def mtls_request(ctx: ssl.SSLContext, method: str, url: str, expected_id: str,
                       headers: dict[str, str] | None = None, body: bytes = b"", timeout: float = 5,
                       attempts: int = 6, handshake_timeout: float = 3, pre_tls_budget: float = 10) -> tuple[int, bytes]:
    """_mtls_once を呼び、まだ応答を受け取っていない失敗なら、最大 attempts 回まで、間を 0.3 秒ずつ延ばして送り直す（段 D の D1-a3）。
    送り直すのは、握手の前の時間切れ（HandshakeTimeout。まだ何も送っていない）と、応答が届く前につなぎが切れたとき（ConnectionError、
    ssl.SSLError、途中で切れた読み取り）である。Service Connect は TCP の中継なので、止まったタスクへ向かったつなぎは、握手で黙る。
    つなぎ直すと、Service Connect が送り先を選び直す。相手の SPIFFE ID が違う（Refused）と、握手のあとの時間切れは、送り直さない。
    待ちは、握手の待ち（handshake_timeout）と、1 回の応答の待ち（timeout）に分ける。呼ぶ側は、外側の待ちより短い値を渡す
    （待ちは外側ほど長くする。2026-11-24 の AWS で、内側と外側が同じ 15 秒だったため、内側が待たされると外側が先に切れた）。
    送り直しは、段（握手か、応答か）と経過の秒つきで、1 行ずつログに出す。
    握手が終わる前の失敗（HandshakeTimeout、BeforeTls。まだ何も送っていない）は、回数に依らず、最初から合わせて pre_tls_budget 秒まで送り直す
    （段 S。0 台から起こした直後は、相手が Service Connect の送り先になるまで、つなぎが握手の前に切られる。findings 5-36）。"""
    import asyncio
    import time as _time

    started = _time.monotonic()
    i = 0
    while True:
        i += 1
        t0 = _time.monotonic()
        try:
            sent = dict(headers or {})
            with tracing.client_span(method, url, sent) as span:
                status, raw = await _mtls_once(ctx, method, url, expected_id, sent, body, timeout, handshake_timeout)
                if span is not None:
                    span.set_attribute("http.response.status_code", status)
                return status, raw
        except Refused:
            raise
        except (HandshakeTimeout, ConnectionError, ssl.SSLError, asyncio.IncompleteReadError) as e:
            before_tls = isinstance(e, (HandshakeTimeout, BeforeTls))
            wait = min(0.3 * i, 1.0)
            retried = i < attempts or (before_tls and _time.monotonic() - started + wait < pre_tls_budget)
            _log_attempt(url=url, attempt=i, phase="handshake" if before_tls else "response", error=type(e).__name__,
                         retried=retried, ms=round((_time.monotonic() - t0) * 1000),
                         total_ms=round((_time.monotonic() - started) * 1000))
            if not retried:
                raise
            await asyncio.sleep(wait)
        except TimeoutError:
            _log_attempt(url=url, attempt=i, phase="response", error="TimeoutError", retried=False,
                         ms=round((_time.monotonic() - t0) * 1000), total_ms=round((_time.monotonic() - started) * 1000))
            raise


async def _mtls_once(ctx: ssl.SSLContext, method: str, url: str, expected_id: str,
                     headers: dict[str, str] | None = None, body: bytes = b"", timeout: float = 5,
                     handshake_timeout: float = 3) -> tuple[int, bytes]:
    """SVID の mTLS で 1 回呼ぶ（HTTP/1.1、Connection: close）。握手のあと、相手の SPIFFE ID を確かめてから、要求を送る。
    トークンを、確かめていない相手に送らないため。接続は使い回さない（入れ替わる前の証明書で示し続けないため）。
    握手は handshake_timeout、応答は timeout まで待つ。"""
    import asyncio
    from urllib.parse import urlsplit

    u = urlsplit(url)
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(u.hostname, u.port or 443, ssl=ctx, server_hostname=u.hostname,
                                    ssl_handshake_timeout=handshake_timeout), handshake_timeout)
    except TimeoutError as e:
        raise HandshakeTimeout(f"握手が {handshake_timeout} 秒で終わらなかった") from e
    except (ConnectionError, ssl.SSLError) as e:
        raise BeforeTls(f"握手の前に切れた: {type(e).__name__}") from e
    try:
        der = writer.get_extra_info("ssl_object").getpeercert(binary_form=True)
        got = spiffe_id_of(der) if der else None
        if got != expected_id:
            raise Refused(f"相手の SPIFFE ID が違う: {got}")
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        head = {"host": u.netloc, "connection": "close", "content-length": str(len(body)), **(headers or {})}
        writer.write(f"{method} {path} HTTP/1.1\r\n".encode() + "".join(f"{k}: {v}\r\n" for k, v in head.items()).encode()
                     + b"\r\n" + body)
        await writer.drain()
        raw = await asyncio.wait_for(reader.read(), timeout)
    finally:
        writer.close()
    head_raw, _, rest = raw.partition(b"\r\n\r\n")
    lines = head_raw.decode("latin-1").split("\r\n")
    status = int(lines[0].split(" ")[1])
    fields = {k.strip().lower(): v.strip() for k, _, v in (line.partition(":") for line in lines[1:])}
    if fields.get("transfer-encoding", "").lower() == "chunked":
        out = b""
        while rest:
            size_raw, _, rest = rest.partition(b"\r\n")
            size = int(size_raw.split(b";")[0], 16)
            if size == 0:
                break
            out, rest = out + rest[:size], rest[size + 2:]
        rest = out
    return status, rest
