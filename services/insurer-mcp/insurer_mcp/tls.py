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


async def mtls_request(ctx: ssl.SSLContext, method: str, url: str, expected_id: str,
                       headers: dict[str, str] | None = None, body: bytes = b"", timeout: float = 15,
                       attempts: int = 3) -> tuple[int, bytes]:
    """_mtls_once を呼び、応答が届く前につなぎが切れたら（ConnectionError、ssl.SSLError、途中で切れた読み取り）、最大 3 回まで送り直す
    （段 D の D1-a3。止まったタスクへのつなぎを、Service Connect は救いきれなかった。2026-11-23 の AWS）。相手の SPIFFE ID が違う（Refused）、
    時間切れは送り直さない。送り直すのは、トークンの交換（トークンがもう 1 つ出るだけ）と、保険会社のシステムの呼び出し（申込みは nonce が
    1 回しか通さない）である。"""
    import asyncio

    for i in range(1, attempts + 1):
        try:
            return await _mtls_once(ctx, method, url, expected_id, headers, body, timeout)
        except Refused:
            raise
        except (ConnectionError, ssl.SSLError, asyncio.IncompleteReadError):
            if i >= attempts:
                raise
            await asyncio.sleep(0.2)
    raise AssertionError("届かない")


async def _mtls_once(ctx: ssl.SSLContext, method: str, url: str, expected_id: str,
                       headers: dict[str, str] | None = None, body: bytes = b"", timeout: float = 15) -> tuple[int, bytes]:
    """SVID の mTLS で 1 回呼ぶ（HTTP/1.1、Connection: close）。握手のあと、相手の SPIFFE ID を確かめてから、要求を送る。
    トークンを、確かめていない相手に送らないため。接続は使い回さない（入れ替わる前の証明書で示し続けないため）。
    待ちは 15 秒。止まったタスクに当たると、Service Connect が別のタスクへつなぎ直すので、その間に見切らない（段 D の D1-a3。推定の値）。"""
    import asyncio
    from urllib.parse import urlsplit

    u = urlsplit(url)
    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(u.hostname, u.port or 443, ssl=ctx, server_hostname=u.hostname), timeout)
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
