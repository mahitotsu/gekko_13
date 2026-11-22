package main

// 監査の画面の入り口の試験。gekko_11 の AuditAccessTest.java を写した。ログインサーバーは呼ばず、セッションを直接置く。

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func testAuth() *Auth {
	return NewAuth(context.Background(), AuthConfig{
		Issuer:       "https://login.test/login/realms/insurer",
		LoginOrigin:  "http://keycloak.test",
		PublicOrigin: "https://app.test/audit",
		JWTSVIDFile:  "/nonexistent",
	})
}

func withSession(a *Auth, sub string, auditor bool) *http.Cookie {
	id := random()
	a.sessions[id] = session{sub: sub, idToken: "id-token-of-" + sub, auditor: auditor, created: time.Now()}
	return &http.Cookie{Name: sessionCookie, Value: id}
}

func get(h http.Handler, path string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func TestNotLoggedInGoesToTheLoginServerWithPkce(t *testing.T) {
	h := Handler("/audit", testAuth(), Reconciler{Source: regular(fixed60, Route, act)})
	w := get(h, "/audit/")
	if w.Code != http.StatusFound {
		t.Fatalf("status = %d", w.Code)
	}
	loc, _ := url.Parse(w.Header().Get("location"))
	q := loc.Query()
	if !strings.HasPrefix(loc.String(), "https://login.test/login/realms/insurer/protocol/openid-connect/auth") ||
		q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("nonce") == "" ||
		q.Get("client_id") != "insurer-audit" || q.Get("redirect_uri") != "https://app.test/audit/login/oauth2/code/insurer-login" {
		t.Fatalf("location = %s", loc)
	}
	// 途中の情報の Cookie は、/audit の下だけに置き、スクリプトから読めない
	c := w.Result().Cookies()[0]
	if c.Path != "/audit" || !c.HttpOnly || !c.Secure {
		t.Fatalf("cookie = %+v", c)
	}
}

func TestOnlyAuditorsSeeTheRecords(t *testing.T) {
	a := testAuth()
	h := Handler("/audit", a, Reconciler{Source: regular(fixed60, Route, act)})
	if w := get(h, "/audit/", withSession(a, "hanako", false)); w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), `data-testid="forbidden"`) {
		t.Fatalf("顧客が監査の画面を見られた: %d", w.Code)
	}
	if w := get(h, "/audit/api/contracts/"+nonce, withSession(a, "hanako", false)); w.Code != http.StatusForbidden {
		t.Fatalf("顧客が監査の記録を読めた: %d", w.Code)
	}
	w := get(h, "/audit/", withSession(a, "kansa", true))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `data-testid="contract-`+nonce+`"`) || !strings.Contains(w.Body.String(), "食い違いなし") {
		t.Fatalf("監査の担当の一覧: %d %s", w.Code, w.Body.String())
	}
}

func TestContractPageStartsWithWhatWasCompared(t *testing.T) {
	a := testAuth()
	h := Handler("/audit", a, Reconciler{Source: regular(fixed60, Route, act)})
	w := get(h, "/audit/contracts/"+nonce, withSession(a, "kansa", true))
	body := w.Body.String()
	if w.Code != http.StatusOK || !strings.Contains(body, `data-testid="status"`) || !strings.Contains(body, "第三者の記録との比較") {
		t.Fatalf("%d", w.Code)
	}
	if strings.Index(body, `data-testid="summary"`) > strings.Index(body, `data-testid="contract-record"`) {
		t.Fatal("何と何を比べたかが、記録の後に出た")
	}
	if get(h, "/audit/contracts/other", withSession(a, "kansa", true)).Code != http.StatusNotFound {
		t.Fatal("ない契約で 404 にならない")
	}
}

func TestSignOutAlsoEndsTheLoginAtTheLoginServer(t *testing.T) {
	a := testAuth()
	h := Handler("/audit", a, Reconciler{Source: regular(fixed60, Route, act)})
	c := withSession(a, "kansa", true)
	req := httptest.NewRequest(http.MethodPost, "/audit/logout", nil)
	req.AddCookie(c)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	loc, _ := url.Parse(w.Header().Get("location"))
	if !strings.HasSuffix(loc.Path, "/protocol/openid-connect/logout") || loc.Query().Get("id_token_hint") != "id-token-of-kansa" ||
		loc.Query().Get("post_logout_redirect_uri") != "https://app.test/audit/" {
		t.Fatalf("location = %s", loc)
	}
	if get(h, "/audit/", c).Code != http.StatusFound {
		t.Fatal("サインアウトのあとも、セッションが残った")
	}
}

func TestStylesAreServedWithoutLogin(t *testing.T) {
	h := Handler("/audit", testAuth(), Reconciler{Source: regular(fixed60, Route, act)})
	if w := get(h, "/audit/assets/audit.css"); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "--primary") {
		t.Fatalf("%d", w.Code)
	}
}

func TestStreamNameDecidesTheWriter(t *testing.T) {
	// 書いた者は、記録の中の service の欄ではなく、ログストリームの名前（タスクの定義が決める）で決める
	forged := Entry{App: "sales-agent", Container: "app", Record: map[string]any{"kind": "exchange", "service": "insurer-auth"}}
	if forged.WrittenByOwner() {
		t.Fatal("営業 AI エージェントが書いた交換の記録を受け付けた")
	}
	if !(Entry{App: "auth", Container: "app", Record: map[string]any{"kind": "exchange"}}).WrittenByOwner() {
		t.Fatal("auth が書いた交換の記録を受け付けない")
	}
	if (Entry{App: "auth", Container: "svid-helper", Record: map[string]any{"kind": "exchange"}}).WrittenByOwner() {
		t.Fatal("app でないコンテナの記録を受け付けた")
	}
	if parseAudit(`{"audit":{"kind":"issue"}}`)["kind"] != "issue" || parseAudit("plain text") != nil {
		t.Fatal("監査の記録の取り出しが違う")
	}
}
