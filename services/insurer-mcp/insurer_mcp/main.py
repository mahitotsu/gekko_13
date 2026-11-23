"""事務サービスを起動する（段 D の D1-a2-2）。

受け口は SVID の mTLS（既定 9443）で、呼べるのは営業 AI エージェントだけ（gekko_11 の G27）。要求ごとに、相手の SPIFFE ID、
トークン B（認可サーバーの公開鍵）、B と相手の証明書の結び付けを確かめてから（guard.py）、MCP のアプリに渡す。
認可サーバーの公開鍵は、SVID の mTLS で、相手の SPIFFE ID を確かめて取る。知らない鍵の ID が来たら、取り直す。
"""

from __future__ import annotations

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
    """認可サーバーの公開鍵。知らない鍵の ID が来たら、10 秒に 1 回まで取り直す。"""

    def __init__(self) -> None:
        self.keys: dict[str | None, Any] = {}
        self.fetched = 0.0

    async def ensure(self, token: str | None) -> None:
        try:
            kid = jwt.get_unverified_header(token).get("kid") if token else None
        except jwt.PyJWTError:
            return
        if kid in self.keys or time.time() - self.fetched < 10:
            return
        self.fetched = time.time()
        status, raw = await app._call("GET", f"{app.AUTH}/oauth2/jwks", app.spiffe("auth"), {"accept": "application/json"})
        if status == 200:
            self.keys = keys_from_jwks(json.loads(raw))


def guard_middleware(inner: Any, guard: Guard, keys: Keys) -> Any:
    async def asgi(scope: dict[str, Any], receive: Any, send: Any) -> None:
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
