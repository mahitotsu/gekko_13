"""事務サービスのツールが、受け口で確かめたトークン B を C に替えて保険会社のシステムへ回し、記録を書くことを確かめる。
gekko_11 の tests/test_tools.py を、gekko_13 の形（B を確かめ、C に替えて mTLS で呼ぶ）に合わせて写した。"""

import base64
import hashlib
import json
import urllib.parse

import pytest
from fastmcp import Client

from insurer_mcp import app


class Request:
    def __init__(self, method: str, url: str, expected: str, headers: dict[str, str], body: bytes):
        self.method, self.url, self.expected, self.headers, self.content = method, url, expected, headers, body

    @property
    def path(self) -> str:
        return urllib.parse.urlsplit(self.url).path


@pytest.fixture
def backend(monkeypatch):
    """保険会社のシステムと認可サーバーの代わり。認可サーバーは、actor のトークンと C を返す。"""
    calls = []

    async def call(method, url, expected, headers, body=b""):
        r = Request(method, url, expected, headers, body)
        if r.path == "/oauth2/token":
            form = urllib.parse.parse_qs(body.decode())
            return 200, json.dumps({"access_token": "token-c" if "subject_token" in form else "token-actor"}).encode()
        calls.append(r)
        if r.path == "/products":
            return 200, json.dumps({"products": []}).encode()
        if r.path == "/quotes":
            return 200, json.dumps({"quotes": [{"plan": {"id": "fixed-60"}}]}).encode()
        if r.path == "/offers":
            return 200, json.dumps({"nonce": "n-1", "offerJws": "jws"}).encode()
        if r.path == "/applications":
            return 200, json.dumps({"ok": True, "contract": {"contractId": "C-1"}}).encode()
        return 403, json.dumps({"error": "利用者本人のトークンではない"}).encode()

    monkeypatch.setattr(app, "_call", call)
    app.VERIFIED.set(("token-b", {"sub": "alice", "act": {"sub": "sales-agent"}, "jti": "j-1"}))
    return calls


async def test_tools_send_token_c_not_token_b(backend):
    async with Client(app.mcp) as client:
        await client.call_tool("get_products", {})
    assert backend[0].headers["authorization"] == "Bearer token-c"
    assert backend[0].expected == "spiffe://gekko13.internal/svc/insurer-backend"


async def test_quotes_and_offers_are_passed_on_and_recorded(backend, capsys):
    conditions = [{"kind": "fixed", "monthly": 20000}]
    plans = [{"kind": "fixed", "monthly": 20000, "benefit": 600000}]
    async with Client(app.mcp) as client:
        await client.call_tool("quote_plan", {"conditions": conditions})
        result = await client.call_tool("issue_offer", {"plans": plans})
    assert json.loads(backend[0].content) == {"conditions": conditions}
    assert json.loads(backend[1].content) == {"plans": plans}
    assert result.data["offerJws"] == "jws"
    lines = [json.loads(line)["audit"] for line in capsys.readouterr().out.strip().splitlines()]
    assert lines[0]["tool"] == "quote_plan"
    assert lines[0]["conditions"] == conditions
    assert lines[1]["tool"] == "issue_offer"
    assert lines[1]["plans"] == plans
    assert lines[1]["nonce"] == "n-1"


async def test_submit_application_passes_extras_and_records_the_call(backend, capsys):
    async with Client(app.mcp) as client:
        result = await client.call_tool("submit_application", {
            "intent": {"nonce": "n-1"}, "application": {"nonce": "n-1"}, "assertion": {},
            "extras": {"contact": "http://elsewhere"}})
    sent = json.loads(backend[-1].content)
    assert sent["contact"] == "http://elsewhere"
    assert result.data["contract"]["contractId"] == "C-1"
    record = json.loads(capsys.readouterr().out.strip().splitlines()[-1])["audit"]
    assert record["kind"] == "tool_call"
    assert record["tool"] == "submit_application"
    assert record["sub"] == "alice"
    assert record["act"] == {"sub": "sales-agent"}
    assert record["contract_id"] == "C-1"
    # 申込みのハッシュは、JCS の SHA-256（顧客のアプリが passkey に署名させた challenge と同じ値）
    assert record["application_hash"] == app.digest({"nonce": "n-1"})


def test_digest_matches_jcs_sha256():
    # canonicalize({"b": 1, "a": "あ"}) は {"a":"あ","b":1}
    expected = base64.urlsafe_b64encode(hashlib.sha256('{"a":"あ","b":1}'.encode()).digest()).rstrip(b"=").decode()
    assert app.digest({"b": 1, "a": "あ"}) == expected


def test_digest_matches_the_customer_app():
    # 顧客のアプリ（TypeScript の canonicalize）で同じ書類を正規化し、SHA-256 を取った値。入れ子、日本語、絵文字、真偽値と null を含む
    document = {"plan": {"kind": "fixed", "monthly": 20000, "benefit": 600000, "termYears": 10}, "customer": "alice",
                "intent": "老後に備えたい😀", "nested": [{"z": 1, "a": [True, None]}]}
    assert app.digest(document) == "sIA9T191TA57UQ7xiBLpagkpw5fwniVy68Q70nJMp_k"


async def test_backend_refusal_is_returned_with_its_status(backend):
    async with Client(app.mcp) as client:
        result = await client.call_tool("list_contracts", {})
    assert result.data["status"] == 403
