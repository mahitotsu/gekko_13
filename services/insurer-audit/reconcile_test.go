package main

// 突き合わせの試験。gekko_11 の ReconcilerTest.java を写した。記録は、各サービスが書く形を、メモリ上に置く。
// 書いた者は、gekko_13 の名前（ログストリームの接頭辞）にした。

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

const nonce = "n-1"

var (
	fixed60     = map[string]any{"id": "fixed-60", "name": "確定年金 10年・年額60万円"}
	life240     = map[string]any{"id": "life-240", "name": "終身年金・年額240万円"}
	application = map[string]any{"customer": "alice", "plan": fixed60, "nonce": nonce}
	act         = map[string]any{"sub": "insurer-mcp", "act": map[string]any{"sub": "sales-agent"}}
)

type memory struct {
	entries []Entry
	self    []map[string]any
	at      int64
}

func (m *memory) add(app, container string, record map[string]any) *memory {
	m.at++
	// JSON で読んだ形にそろえる（記録の集約から読むときと同じ型にする）
	raw, _ := json.Marshal(record)
	var r map[string]any
	_ = json.Unmarshal(raw, &r)
	m.entries = append(m.entries, Entry{App: app, Container: container, At: m.at, Record: r})
	return m
}

func (m *memory) Search(needle string) ([]Entry, error) {
	var out []Entry
	for _, e := range m.entries {
		raw, _ := json.Marshal(e.Record)
		if strings.Contains(string(raw), needle) {
			out = append(out, e)
		}
	}
	return out, nil
}

func (m *memory) Contracts() ([]Entry, error) {
	var out []Entry
	for _, e := range m.entries {
		if e.Kind() == "contract" {
			out = append(out, e)
		}
	}
	return out, nil
}

func (m *memory) SelfReported() ([]map[string]any, error) { return m.self, nil }

func (m *memory) remove(kind string) {
	var kept []Entry
	for _, e := range m.entries {
		if e.Kind() != kind {
			kept = append(kept, e)
		}
	}
	m.entries = kept
}

func jsonOf(v any) map[string]any {
	raw, _ := json.Marshal(v)
	var r map[string]any
	_ = json.Unmarshal(raw, &r)
	return r
}

// regular は、正規の申込み: ログインの A、営業 AI エージェントの B、事務サービスの C、ツールの記録、契約の記録、会話。
func regular(contractPlan map[string]any, by any, cAct any) *memory {
	h := hash(application)
	contract := map[string]any{"contractId": "C-1", "customer": "alice", "plan": contractPlan, "nonce": nonce}
	m := &memory{}
	m.add("keycloak", "app", map[string]any{"kind": "issue", "client": "customer-app", "sub": "alice", "jti": "jA"}).
		add("auth", "app", map[string]any{"kind": "exchange", "client": "sales-agent", "sub": "alice", "jti": "jB", "from_jti": "jA", "act": map[string]any{"sub": "sales-agent"}}).
		add("auth", "app", map[string]any{"kind": "exchange", "client": "insurer-mcp", "sub": "alice", "jti": "jC", "from_jti": "jB", "act": cAct}).
		add("sales-agent", "app", map[string]any{"kind": "conversation", "thread": "t-1", "event": "agent_tool", "name": "issue_offer", "nonce": nonce}).
		add("sales-agent", "app", map[string]any{"kind": "conversation", "thread": "t-1", "event": "frontend_tool", "name": "present_application", "document_hash": h}).
		add("insurer-mcp", "app", map[string]any{"kind": "tool_call", "tool": "submit_application", "sub": "alice", "jti": "jB", "nonce": nonce,
			"customer": "alice", "plan": fixed60, "application_hash": h, "contract_id": "C-1", "status": 200}).
		add("insurer-backend", "app", map[string]any{"kind": "contract", "contract": contract, "by": by, "token_jti": "jC", "application_hash": h})
	m.self = append(m.self, jsonOf(map[string]any{"contract": contract, "by": by, "application": application, "tokenJti": "jC"}))
	return m
}

func reconcile(t *testing.T, m *memory) *Report {
	t.Helper()
	r, err := Reconciler{Source: m}.Reconcile(nonce)
	if err != nil || r == nil {
		t.Fatalf("突き合わせができない: %v", err)
	}
	return r
}

func results(r *Report) map[string]bool {
	out := map[string]bool{}
	for _, c := range r.Checks {
		out[regexp.MustCompile(`（.*`).ReplaceAllString(c.Name, "")] = c.OK
	}
	return out
}

func TestRegularContractHasNoMismatch(t *testing.T) {
	r := reconcile(t, regular(fixed60, Route, act))
	if r.Status != "食い違いなし" {
		t.Fatalf("status = %s: %+v", r.Status, r.Checks)
	}
	var jtis []string
	for _, c := range r.Chain {
		jtis = append(jtis, str(c["jti"]))
	}
	if strings.Join(jtis, ",") != "jC,jB,jA" || len(r.Conversation) != 2 || len(r.Rejected) != 0 {
		t.Fatalf("chain=%v conversation=%d rejected=%d", jtis, len(r.Conversation), len(r.Rejected))
	}
}

func TestReportShowsWhatWasComparedGroupedByTheStrengthOfTheEvidence(t *testing.T) {
	r := reconcile(t, regular(life240, Route, act))
	g := r.Groups()
	var titles []string
	for _, x := range g {
		titles = append(titles, x.Title)
	}
	if strings.Join(titles, ",") != "第三者の記録との比較,同じ書き手の記録どうしの比較,自己申告との比較,記録の書き手" {
		t.Fatalf("titles = %v", titles)
	}
	if g[0].OK || !regexp.MustCompile(`^\d+ 点中 \d+ 点が一致$`).MatchString(g[0].Summary) {
		t.Fatalf("group0 = %+v", g[0])
	}
	// 自己申告と CloudWatch Logs の記録は同じ案なので、同じ書き手どうしの比較では、案の食い違いに気付けない
	if !g[1].OK {
		t.Fatal("同じ書き手どうしの比較が食い違いになった")
	}
	var plan *Comparison
	for _, c := range g[0].Checks {
		for i := range c.Comparisons {
			if c.Comparisons[i].What == "案" {
				plan = &c.Comparisons[i]
			}
		}
	}
	want := Comparison{What: "案", Left: "life-240", LeftBy: "保険会社のシステム", Right: "fixed-60", RightBy: "事務サービス", OK: false}
	if plan == nil || *plan != want {
		t.Fatalf("案の比較 = %+v", plan)
	}
	// 判定が一致なら、比べた値もすべて一致で、判定と食い違わない
	ok := reconcile(t, regular(fixed60, Route, act))
	n := 0
	for _, c := range ok.Checks {
		for _, v := range c.Comparisons {
			n++
			if !v.OK {
				t.Fatalf("一致の判定の中に、食い違いの比較がある: %+v", v)
			}
		}
	}
	if n == 0 {
		t.Fatal("比べた値がない")
	}
}

func TestContractPlanDifferentFromSubmittedApplicationIsAMismatch(t *testing.T) {
	// シナリオ 10: 保険会社のシステムが、申込みと違う案で契約を記録した
	r := reconcile(t, regular(life240, Route, act))
	res := results(r)
	if r.OK || res["申込みの中身"] || !res["トークンの連鎖"] {
		t.Fatalf("%v", res)
	}
}

func TestContractWithoutActIsARouteMismatch(t *testing.T) {
	// シナリオ 20: 経由を残さない発行で、契約の記録に経由がない
	res := results(reconcile(t, regular(fixed60, []any{}, nil)))
	if res["経由"] || !res["トークンの連鎖"] {
		t.Fatalf("%v", res)
	}
}

func TestCustomerTokenSentStraightToTheBackendHasNoToolRecordAndNoChain(t *testing.T) {
	// シナリオ 14: 営業 AI エージェント宛ての A で、保険会社のシステムへ直接申し込んだ
	m := regular(fixed60, []any{}, nil)
	m.remove("tool_call")
	m.remove("contract")
	contract := map[string]any{"contractId": "C-1", "customer": "alice", "plan": fixed60, "nonce": nonce}
	m.add("insurer-backend", "app", map[string]any{"kind": "contract", "contract": contract, "by": []any{}, "token_jti": "jA", "application_hash": hash(application)})
	m.self[0] = jsonOf(map[string]any{"contract": contract, "by": []any{}, "application": application, "tokenJti": "jA"})
	res := results(reconcile(t, m))
	if res["事務サービスの記録"] || res["トークンの連鎖"] {
		t.Fatalf("%v", res)
	}
}

func TestRecordWrittenByAnotherTaskIsNotAccepted(t *testing.T) {
	// 乗っ取られた営業 AI エージェントが、認可サーバーを名乗って、C の交換の記録を偽って書く
	m := regular(fixed60, Route, act)
	m.add("sales-agent", "app", map[string]any{"kind": "exchange", "service": "insurer-auth", "client": "insurer-mcp", "sub": "alice", "jti": "jC", "from_jti": "jX", "act": map[string]any{"sub": "insurer-mcp"}})
	r := reconcile(t, m)
	res := results(r)
	if !res["トークンの連鎖"] || res["書いた者"] {
		t.Fatalf("%v", res)
	}
	if len(r.Rejected) != 1 || r.Rejected[0]["app"] != "sales-agent" || str(r.Chain[0]["from_jti"]) != "jB" {
		t.Fatalf("rejected=%v chain=%v", r.Rejected, r.Chain)
	}
}

func TestConversationIsOnlyComparedAndMayBeMissing(t *testing.T) {
	m := regular(fixed60, Route, act)
	m.remove("conversation")
	r := reconcile(t, m)
	// 会話がなければ、比べていないと示し、一致と見せない
	if !r.OK || r.Groups()[2].Verdict != "比べていない" {
		t.Fatalf("ok=%v verdict=%s", r.OK, r.Groups()[2].Verdict)
	}
	if v := reconcile(t, regular(fixed60, Route, act)).Groups()[2].Verdict; v != "一致" {
		t.Fatalf("verdict = %s", v)
	}
	shown := regular(fixed60, Route, act)
	shown.add("sales-agent", "app", map[string]any{"kind": "conversation", "thread": "t-1", "event": "frontend_tool", "name": "present_application", "document_hash": "other"})
	if results(reconcile(t, shown))["会話"] {
		t.Fatal("示した申込みと取り次いだ申込みの違いに気付かない")
	}
}

func TestSelfReportDifferentFromLoggedContractIsAMismatch(t *testing.T) {
	m := regular(fixed60, Route, act)
	changed := map[string]any{}
	for k, v := range m.self[0] {
		changed[k] = v
	}
	changed["contract"] = jsonOf(map[string]any{"contractId": "C-1", "customer": "alice", "plan": life240, "nonce": nonce})
	m.self[0] = changed
	if results(reconcile(t, m))["自己申告と、契約の記録"] {
		t.Fatal("自己申告と記録の違いに気付かない")
	}
}

func TestHashMatchesTheOtherLanguages(t *testing.T) {
	// 事務サービス（Python の rfc8785）と顧客のアプリ（canonicalize）と同じ算出: JCS の {"a":"あ","b":1} の SHA-256 の base64url
	if got := hash(map[string]any{"b": 1, "a": "あ"}); got != "sf4jiE53RZIhEF_FkYIEAFPFfHlYyc18gU0kfnJ0zhk" {
		t.Fatalf("hash = %v", got)
	}
}
