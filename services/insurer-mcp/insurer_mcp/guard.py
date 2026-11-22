"""受け口でサービスのトークン（B）を確かめる（gekko_11 の token-guard の受け口。防御 G1、G26、G27、G29）。

gekko_11 では、Envoy と token-guard（TypeScript）が確かめ、このアプリは主張だけを受け取った。gekko_13 は Envoy を置かないので、
このアプリが自分で確かめる。拒む理由の符号と確かめる順は、TypeScript（packages/token-guard）と Java（保険会社のシステム）とそろえ、
共通の例（packages/token-guard/vectors/service-token.json）で、同じ判定になることを試験で確かめる。
確かめる順: 相手の SPIFFE ID → Authorization: Bearer → 署名 → typ → iss → aud → exp → cnf の x5t#S256 と相手の証明書。
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import jwt


class Refusal(Exception):
    def __init__(self, status: int, reason: str, message: str):
        super().__init__(message)
        self.status = status
        self.reason = reason


@dataclass
class Peer:
    spiffe_id: str | None = None
    x5t_s256: str | None = None


@dataclass
class Guard:
    service: str
    issuer: str
    allowed_callers: list[str]
    #: kid から公開鍵を返す。見つからなければ None
    key_for: Callable[[str | None], Any]
    now: Callable[[], float] = time.time

    def check(self, authorization: str | None, peer: Peer) -> tuple[str, dict[str, Any]]:
        if not peer.spiffe_id:
            raise Refusal(401, "no_peer", "相手の証明書がない")
        if peer.spiffe_id not in self.allowed_callers:
            raise Refusal(403, "wrong_caller", f"呼んでよい相手ではない: {peer.spiffe_id}")
        parts = (authorization or "").split(" ")
        if len(parts) != 2 or parts[0] != "Bearer" or not parts[1]:
            raise Refusal(401, "no_token", "Authorization: Bearer がない")
        token = parts[1]
        claims = self.verify(token)
        bound = (claims.get("cnf") or {}).get("x5t#S256")
        if not bound or not peer.x5t_s256 or bound != peer.x5t_s256:
            raise Refusal(401, "not_bound", "トークンが、相手の証明書に結ばれていない")
        return token, claims

    def verify(self, token: str) -> dict[str, Any]:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as e:
            raise Refusal(401, "bad_token", f"トークンが読めない: {e}") from e
        if header.get("alg") != "RS256":
            raise Refusal(401, "bad_signature", f"alg が RS256 でない: {header.get('alg')}")
        key = self.key_for(header.get("kid"))
        if key is None:
            raise Refusal(401, "bad_signature", "公開鍵が見つからない")
        try:
            # 署名だけを確かめる。主張の確かめは、ほかの言語と同じ順で、下で行う
            claims = jwt.decode(token, key, algorithms=["RS256"],
                                options={"verify_aud": False, "verify_iss": False, "verify_exp": False,
                                         "verify_iat": False, "verify_nbf": False, "require": []})
        except jwt.InvalidSignatureError as e:
            raise Refusal(401, "bad_signature", f"署名が違う: {e}") from e
        except jwt.PyJWTError as e:
            raise Refusal(401, "bad_token", f"トークンを確かめられない: {e}") from e
        if header.get("typ") != "at+jwt":
            raise Refusal(401, "bad_typ", f"typ が at+jwt でない: {header.get('typ')}")
        if claims.get("iss") != self.issuer:
            raise Refusal(401, "bad_issuer", f"発行者が違う: {claims.get('iss')}")
        aud = claims.get("aud")
        auds = aud if isinstance(aud, list) else [aud]
        if self.service not in auds:
            raise Refusal(401, "bad_audience", f"宛先が違う: {aud}")
        exp = claims.get("exp")
        if not isinstance(exp, (int, float)) or exp <= self.now():
            raise Refusal(401, "expired", "期限が切れた")
        if not isinstance(claims.get("sub"), str):
            raise Refusal(401, "bad_token", "sub がない")
        return claims


def keys_from_jwks(jwks: dict[str, Any]) -> dict[str | None, Any]:
    """JWKS（RSA の公開鍵）を、kid ごとの鍵にする。"""
    out: dict[str | None, Any] = {}
    for k in jwks.get("keys", []):
        if k.get("kty") == "RSA":
            out[k.get("kid")] = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(k))
    return out
