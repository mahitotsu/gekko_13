"""事務サービスを起動する（段 D の D1-a2-2）。

受け口は SVID の mTLS（既定 9443）で、呼べるのは営業 AI エージェントだけ（gekko_11 の G27）。要求ごとに、相手の SPIFFE ID、
トークン B（認可サーバーの公開鍵）、B と相手の証明書の結び付けを確かめてから（guard.py）、MCP のアプリに渡す。
認可サーバーの公開鍵は、SVID の mTLS で、相手の SPIFFE ID を確かめて取る。知らない鍵の ID が来たら、取り直す。
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

import jwt
import uvicorn

from insurer_mcp import app
from insurer_mcp.guard import Guard, Peer, Refusal, keys_from_jwks
from insurer_mcp.tls import (
    PEER_CERTS,
    PeerCertProtocol,
    SvidSource,
    spiffe_id_of,
    x5t_s256,
)


def log(**o: Any) -> None:
    print(json.dumps({"svc": "insurer-mcp", **o}, ensure_ascii=False), flush=True)


class Keys:
    """認可サーバーの公開鍵。起動したらすぐ取り（warm）、知らない鍵の ID が来たら、10 秒に 1 回まで取り直す。"""

    def __init__(self) -> None:
        self.keys: dict[str | None, Any] = {}
        self.fetched = 0.0
        self._warming: asyncio.Task[None] | None = None

    async def _fetch(self) -> None:
        status, raw = await app._call("GET", f"{app.AUTH}/oauth2/jwks", app.spiffe("auth"), {"accept": "application/json"})
        if status != 200:
            raise RuntimeError(f"認可サーバーの公開鍵を取れない: {status}")
        self.keys = keys_from_jwks(json.loads(raw))

    async def warm(self, max_delay: float = 10.0, first_delay: float = 1.0) -> None:
        """取れるまで、間を延ばして取り直す。受け始めるのは待たない（段 D の D1-a3）。
        鍵を持たないまま要求を受けると、その要求の中で取りに行き、送り先が止まった直後には待たされる（2026-11-24 の AWS）。"""
        delay = first_delay
        while True:
            try:
                await self._fetch()
                self.fetched = time.time()
                log(event="keys_ready")
                return
            except Exception as e:  # noqa: BLE001  取れなければ、間を置いて取り直す
                log(event="keys_retry", error=str(e), in_s=delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, max_delay)

    def start_warming(self) -> None:
        if self._warming is None:
            self._warming = asyncio.get_running_loop().create_task(self.warm())

    async def ensure(self, token: str | None) -> None:
        try:
            kid = jwt.get_unverified_header(token).get("kid") if token else None
        except jwt.PyJWTError:
            return
        if kid in self.keys or time.time() - self.fetched < 10:
            return
        self.fetched = time.time()
        try:
            await self._fetch()
        except Exception as e:  # noqa: BLE001  取り直せなければ、手元の鍵で確かめ続ける
            log(event="keys_refresh_failed", error=str(e))


def guard_middleware(inner: Any, guard: Guard, keys: Keys) -> Any:
    async def asgi(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] == "lifespan":
            # 起動の直後に、鍵を取りに行く（サーバーと同じイベントループで）
            keys.start_warming()
        if scope["type"] != "http":
            return await inner(scope, receive, send)
        client = scope.get("client")
        der = PEER_CERTS.get((client[0], client[1])) if client else None
        peer = Peer(spiffe_id_of(der), x5t_s256(der)) if der else Peer()
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        authorization = headers.get("authorization")
        try:
            await keys.ensure((authorization or "").removeprefix("Bearer "))
            token, claims = guard.check(authorization, peer)
        except Refusal as e:
            log(event="refused", reason=e.reason, error=str(e), peer=peer.spiffe_id)
            body = json.dumps({"error": str(e), "reason": e.reason}, ensure_ascii=False).encode()
            await send({"type": "http.response.start", "status": e.status, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": body})
            return
        reset = app.VERIFIED.set((token, claims))
        try:
            await inner(scope, receive, send)
        finally:
            app.VERIFIED.reset(reset)

    return asgi


def main() -> None:
    svids = SvidSource(os.environ.get("SVID_DIR", "/svid"))
    svids.wait()
    server_ctx = svids.server_context()
    app.client_ssl = svids.client_context()
    app.pinned_ssl = svids.pinned_client_context
    svids.watch()
    keys = Keys()
    guard = Guard(service="insurer-mcp", issuer=os.environ.get("ISSUER", app.AUTH),
                  allowed_callers=[app.spiffe("sales-agent")], key_for=lambda kid: keys.keys.get(kid))
    port = int(os.environ.get("APP_PORT", "9443"))
    config = uvicorn.Config(guard_middleware(app.create_app(), guard, keys), host="0.0.0.0", port=port,
                            http=PeerCertProtocol, lifespan="on", log_level="warning")
    config.load()
    # uvicorn は SSLContext をファイルから作るので、SVID から作ったもの（入れ替えで読み直す）に差し替える
    config.ssl = server_ctx
    log(event="listening", port=port, mtls=True)
    uvicorn.Server(config).run()


if __name__ == "__main__":
    main()
