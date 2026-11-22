"""共通の例（packages/token-guard/vectors/service-token.json）で、Python の確かめが TypeScript と Java と同じ判定をするかを見る。"""

import json
import pathlib

import pytest

from insurer_mcp.guard import Guard, Peer, Refusal, keys_from_jwks

VECTORS = json.loads((pathlib.Path(__file__).parents[3] / "packages/token-guard/vectors/service-token.json").read_text())
KEYS = keys_from_jwks(VECTORS["jwks"])
GUARD = Guard(service=VECTORS["service"], issuer=VECTORS["issuer"], allowed_callers=VECTORS["allowedCallers"],
              key_for=KEYS.get, now=lambda: VECTORS["now"])


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_vector(case):
    peer = Peer(case["peer"].get("spiffeId"), case["peer"].get("x5tS256"))
    try:
        GUARD.check(case.get("authorization"), peer)
        got = "ok"
    except Refusal as e:
        got = e.reason
    assert got == case["expect"]
