package main

// セッションの置き場所（段 D の D1-a3。判断 53）。2 つのタスクで共有するときの約束を、メモリの実装で確かめる。

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLoginStateIsHandedOutOnce(t *testing.T) {
	s := newMemState()
	ctx := context.Background()
	_ = s.Put(ctx, "login", "x", []byte("途中"), time.Now().Add(time.Minute))
	if v, ok, _ := s.Take(ctx, "login", "x"); !ok || string(v) != "途中" {
		t.Fatalf("1 回目 = %q, %v", v, ok)
	}
	if _, ok, _ := s.Take(ctx, "login", "x"); ok {
		t.Fatal("2 回目も渡した")
	}
}

func TestExpiredStateIsNotRead(t *testing.T) {
	s := newMemState()
	ctx := context.Background()
	_ = s.Put(ctx, "session", "x", []byte("古い"), time.Now().Add(-time.Second))
	if _, ok, _ := s.Get(ctx, "session", "x"); ok {
		t.Fatal("期限を過ぎたものを読んだ")
	}
}

func TestLogoutRemovesTheSharedSession(t *testing.T) {
	a := testAuth()
	c := withSession(a, "kansa", true)
	req := httptestRequest(c)
	if a.Current(req) == nil {
		t.Fatal("ログインしていない")
	}
	w := newRecorder()
	a.Logout(w, req)
	if a.Current(req) != nil {
		t.Fatal("ログアウトしても、セッションが残った")
	}
}

func httptestRequest(c *http.Cookie) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/audit/logout", nil)
	req.AddCookie(c)
	return req
}

func newRecorder() *httptest.ResponseRecorder { return httptest.NewRecorder() }
