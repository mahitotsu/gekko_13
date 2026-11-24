"""認可サーバーの公開鍵を、起動の直後に取り、取れるまで取り直すことを確かめる（段 D の D1-a3）。"""

import json

from insurer_mcp import app
from insurer_mcp.main import Keys

JWKS = {"keys": [{"kty": "RSA", "kid": "k1", "n": "sXchDaQebHnPiGvyDOAT4saGEUetSyo9MKLOoWFsueri23bOdgWp4Dy1WlUzewbgBHod5pcM9H95GQRV3JDXboIRROSBigeC5yjU1hGzHHyXss8UDprecbAYxknTcQkhslANGRUZmdTOQ5qTRsLAt6BTYuyvVRdhS8exSZEy_c4gs_7svlJJQ4H9_NxsiIoLwAEk7-Q3UXERGYw_75IDrGA84-lA_-Ct4eTlXHBIY2EaV7t7LjJaynVJCpkv4LKjTTAumiGUIuQhrNhZLuF_RJLqHpM2kgWFLU7-VTdL1VbC2tejvcI2BlMkEpk1BzBZI0KQB0GaDWFLN-aEAw3vRw", "e": "AQAB"}]}


async def test_warm_retries_until_keys_are_fetched(monkeypatch):
    calls = []

    async def call(method, url, expected, headers, body=b""):
        calls.append(url)
        if len(calls) < 3:
            raise OSError("つながらない")
        return 200, json.dumps(JWKS).encode()

    monkeypatch.setattr(app, "_call", call)
    keys = Keys()
    await keys.warm(max_delay=0.02, first_delay=0.01)
    assert len(calls) == 3
    assert "k1" in keys.keys


async def test_refresh_failure_keeps_the_keys_in_hand(monkeypatch):
    async def call(method, url, expected, headers, body=b""):
        raise OSError("つながらない")

    monkeypatch.setattr(app, "_call", call)
    keys = Keys()
    keys.keys = {"k1": object()}
    # 知らない kid が来て取り直しに失敗しても、例外にせず、手元の鍵を残す
    await keys.ensure("eyJhbGciOiJSUzI1NiIsImtpZCI6Im90aGVyIn0.e30.x")
    assert "k1" in keys.keys
