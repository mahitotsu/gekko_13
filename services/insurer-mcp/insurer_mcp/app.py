"""事務サービス（insurer-mcp）。営業 AI エージェントが MCP で呼ぶ窓口（gekko_11 の architecture の 2 章。段 D の D1-a2-2）。

gekko_11 では、Envoy と token-guard が、受け口でトークンを確かめ、出口でトークンを替えた。gekko_13 は Envoy を置かないので、
受け口（main.py の guard_middleware）が SVID の mTLS とトークン B を確かめ、保険会社のシステムを呼ぶときに、B を C に替える（exchange）。
ツールの呼び出しは、1 件ずつ記録として標準出力に書く（gekko_11 の D-17）。
"""

import base64
import contextvars
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.parse
from typing import Any

import rfc8785
from fastmcp import FastMCP

from insurer_mcp.tls import mtls_request

TRUST_DOMAIN = os.environ.get("TRUST_DOMAIN", "gekko13.internal")
BACKEND = os.environ.get("BACKEND_URL", "https://insurer-backend:9443")
AUTH = os.environ.get("AUTH_ORIGIN", "https://auth:8443")
ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token"

mcp = FastMCP("insurer-mcp")

#: 受け口で確かめたトークン B と主張。受け口（main.py）が、要求ごとに入れる
VERIFIED: contextvars.ContextVar[tuple[str, dict[str, Any]] | None] = contextvars.ContextVar("verified", default=None)
#: 呼ぶ側の SSLContext（main.py が SVID から作る）
client_ssl: ssl.SSLContext | None = None
#: 1 回の呼び出しの間、同じ SVID を使う SSLContext を作る関数（main.py が入れる。段 D の D1-a3）
pinned_ssl: Any = None
#: いまの呼び出しで使う SSLContext。_backend が、交換と保険会社のシステムの呼び出しで同じものを使うよう入れる
CALL_SSL: contextvars.ContextVar[ssl.SSLContext | None] = contextvars.ContextVar("call_ssl", default=None)


def spiffe(service: str) -> str:
    return f"spiffe://{TRUST_DOMAIN}/svc/{service}"


async def _call(method: str, url: str, expected: str, headers: dict[str, str], body: bytes = b"") -> tuple[int, bytes]:
    """SVID の mTLS で呼ぶ。テストで差し替えられるよう、1 か所にまとめる。"""
    ctx = CALL_SSL.get() or client_ssl
    if ctx is None:
        raise RuntimeError("SVID を読んでいない")
    return await mtls_request(ctx, method, url, expected, headers, body)


async def exchange(subject_token: str) -> str:
    """B を、保険会社のシステム宛ての C に替える（gekko_11 の D-7 の替える段の手順）。actor_token は、自分の証明書に結んだ自分のトークン。
    SVID が入れ替わると前の証明書に結んだトークンは使えないので、替えるたびに取り直す。"""

    async def token(params: dict[str, str]) -> str:
        body = urllib.parse.urlencode({"client_id": "insurer-mcp", **params}).encode()
        status, raw = await _call("POST", f"{AUTH}/oauth2/token", spiffe("auth"),
                                  {"content-type": "application/x-www-form-urlencoded", "accept": "application/json"}, body)
        parsed = json.loads(raw or b"{}")
        if status >= 400 or "access_token" not in parsed:
            raise PermissionError(f"認可サーバーが拒否した: {status} {parsed.get('error', '')} {parsed.get('error_description', '')}")
        return parsed["access_token"]

    actor = await token({"grant_type": "client_credentials"})
    return await token({"grant_type": "urn:ietf:params:oauth:grant-type:token-exchange", "subject_token": subject_token,
                        "subject_token_type": ACCESS_TOKEN, "actor_token": actor, "actor_token_type": ACCESS_TOKEN,
                        "audience": "insurer-backend", "scope": "apply"})


def _claims() -> dict[str, Any]:
    verified = VERIFIED.get()
    return verified[1] if verified else {}


def digest(value: Any) -> str:
    """JCS（RFC 8785）で正規化した内容の SHA-256 の base64url（D-1 の challenge と同じ値）。
    正規化は、ほかの言語と同じく、RFC 8785 の実装（rfc8785）に任せる。"""
    return base64.urlsafe_b64encode(hashlib.sha256(rfc8785.dumps(value)).digest()).rstrip(b"=").decode()


def _record(tool: str, detail: dict[str, Any]) -> None:
    """ツールの呼び出しの記録（監査の形。D-17、D-30）。誰の依頼か（sub）と、誰が取り次いだか（act）を、トークンの主張から書く。
    ECS の awslogs が CloudWatch Logs に送る。トークンと署名の値は書かない。"""
    claims = _claims()
    record = {"kind": "tool_call", "at": int(time.time()), "service": "insurer-mcp", "tool": tool, "sub": claims.get("sub"),
              "act": claims.get("act"), "jti": claims.get("jti"), **detail}
    print(json.dumps({"audit": record}, ensure_ascii=False), file=sys.stdout, flush=True)


async def _backend(method: str, path: str, json_body: Any = None) -> Any:
    """保険会社のシステムを、B を替えた C で呼ぶ。"""
    verified = VERIFIED.get()
    if not verified:
        return {"status": 401, "error": "確かめたトークンがない"}
    # 交換と保険会社のシステムの呼び出しで、同じ SVID の証明書を使う。C は交換のときの証明書に結ばれるので、途中で SVID が入れ替わると、
    # 保険会社のシステムが not_bound で断る（2026-11-23 の AWS。段 D の D1-a3）
    if pinned_ssl is not None:
        CALL_SSL.set(pinned_ssl())
    try:
        c = await exchange(verified[0])
    except PermissionError as e:
        return {"status": 403, "error": str(e)}
    headers = {"authorization": f"Bearer {c}", "accept": "application/json"}
    body = b""
    if json_body is not None:
        headers["content-type"] = "application/json"
        body = json.dumps(json_body, ensure_ascii=False).encode()
    status, raw = await _call(method, f"{BACKEND}{path}", spiffe("insurer-backend"), headers, body)
    try:
        parsed = json.loads(raw or b"{}")
    except ValueError:
        parsed = {"error": raw.decode(errors="replace")}
    return {"status": status, **parsed} if status >= 400 else parsed


@mcp.tool
async def get_products() -> Any:
    """商品の規則を取る。案を組み立てる前に読む。"""
    result = await _backend("GET", "/products")
    _record("get_products", {})
    return result


@mcp.tool
async def quote_plan(conditions: list[dict[str, Any]]) -> Any:
    """条件（kind、termYears、payYears、monthly）から、年金の年額を試算する。署名はない。掛け金を変えて繰り返せる。
    示さなかった案も後から追えるように、全ての試算を記録に残す（gekko_11 の P-17）。誰の試算かは、保険会社のシステムがトークンの本人から決める（gekko_11 の G9、D-45）。"""
    result = await _backend("POST", "/quotes", {"conditions": conditions})
    _record("quote_plan", {"conditions": conditions, "quotes": result.get("quotes") if isinstance(result, dict) else None})
    return result


@mcp.tool
async def issue_offer(plans: list[dict[str, Any]]) -> Any:
    """組み立てた案を提出する。保険会社のシステムが、規則と金額を確かめて署名する。合わなければ、理由を返す。"""
    result = await _backend("POST", "/offers", {"plans": plans})
    _record("issue_offer", {"plans": plans, "nonce": result.get("nonce") if isinstance(result, dict) else None,
                            "status": result.get("status", 200) if isinstance(result, dict) else None})
    return result


@mcp.tool
async def list_contracts() -> Any:
    """契約の一覧を照会する。誰の契約かは、保険会社のシステムがトークンの本人から決める（gekko_11 の G9、D-45）。"""
    result = await _backend("GET", "/contracts")
    _record("list_contracts", {})
    return result


@mcp.tool
async def submit_application(intent: dict[str, Any], application: dict[str, Any], assertion: Any,
                             intent_assertion: Any = None, offer_jws: str | None = None,
                             extras: dict[str, Any] | None = None) -> Any:
    """顧客が署名した意向確認と申込みを、保険会社のシステムへ回す。extras は窓口が足せる欄で、保険会社のシステムは信じない。"""
    body = {"offerJws": offer_jws, "intent": intent, "intentAssertion": intent_assertion,
            "application": application, "assertion": assertion, **(extras or {})}
    result = await _backend("POST", "/applications", body)
    # 取り次いだ申込みの案と顧客を残す。監査サービスが、保険会社のシステムの契約の記録と照らす
    # 申込みと意向確認のハッシュは、監査の突き合わせの根拠になる（保険会社の側で算出する。D-32）
    _record("submit_application", {"nonce": application.get("nonce"), "customer": application.get("customer"),
                                   "plan": application.get("plan"),
                                   "application_hash": digest(application), "intent_hash": digest(intent),
                                   "contract_id": (result.get("contract") or {}).get("contractId")
                                   if isinstance(result, dict) else None,
                                   "status": result.get("status", 200) if isinstance(result, dict) else None})
    return result


def create_app():
    # MCP の SDK は、Host を見て、DNS の付け替えの手口を断る。呼ばれる名前（Service Connect の名前）だけを許す
    return mcp.http_app(path="/mcp", stateless_http=True, json_response=True,
                        allowed_hosts=["insurer-mcp:9443", "127.0.0.1:9443", "localhost:9443"])
