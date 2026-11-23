package main

// 監査の担当のログイン（gekko_11 の SecurityConfig。gekko_11 の D-31）。OpenID Connect の認可コードと PKCE を使い、
// クライアント認証は JWT-SVID（gekko_11 の D-38）。ID トークンは go-oidc で、公開の名前の issuer として確かめる。
// 画面と記録は、ID トークンの roles に AUDITOR がある者にだけ見せる。全ての顧客の契約と会話が出るからである。
// セッションは、2 つのタスクで共有するため、共有のデータベースに置く（段 D の D1-a3。state.go）。Cookie は /audit の下だけに置き、
// 顧客のアプリのセッションと分ける。

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const (
	clientID      = "insurer-audit"
	sessionCookie = "__Secure-audit-session"
	loginCookie   = "__Secure-audit-login"
	callbackPath  = "/login/oauth2/code/insurer-login"
	sessionMaxAge = time.Hour
)

// AuthConfig は、ログインの設定。
type AuthConfig struct {
	// Issuer は、ログインサーバーの公開の issuer（ブラウザが行く先で、ID トークンの iss）
	Issuer string
	// LoginOrigin は、トークンと公開鍵を取りに行く先の origin。AWS では Issuer と同じ公開の名前、手元ではコンテナの名前
	LoginOrigin string
	// PublicOrigin は、監査の画面の公開の URL（/audit まで）
	PublicOrigin string
	// JWTSVIDFile は、クライアント認証に示す JWT-SVID のファイル
	JWTSVIDFile string
}

type session struct {
	Sub     string    `json:"sub"`
	IDToken string    `json:"idToken"`
	Auditor bool      `json:"auditor"`
	Created time.Time `json:"created"`
}

type pending struct {
	State    string `json:"state"`
	Nonce    string `json:"nonce"`
	Verifier string `json:"verifier"`
}

const loginMaxAge = 10 * time.Minute

// Auth は、ログインとセッションを扱う。
type Auth struct {
	cfg      AuthConfig
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
	store    stateStore
}

// NewAuth は、ログインサーバーの受け口を 1 つずつ決める。公開の名前と、取りに行く先が違うことがあるので、発見の文書は使わない。
// store は、セッションとログインの途中の情報の置き場所（state.go）。
func NewAuth(ctx context.Context, cfg AuthConfig, store stateStore) *Auth {
	path := mustURL(cfg.Issuer).Path
	internal := strings.TrimRight(cfg.LoginOrigin, "/") + path
	keys := oidc.NewRemoteKeySet(ctx, internal+"/protocol/openid-connect/certs")
	return &Auth{
		cfg: cfg,
		oauth: oauth2.Config{
			ClientID:    clientID,
			RedirectURL: cfg.PublicOrigin + callbackPath,
			Scopes:      []string{oidc.ScopeOpenID},
			Endpoint: oauth2.Endpoint{
				AuthURL:   cfg.Issuer + "/protocol/openid-connect/auth",
				TokenURL:  internal + "/protocol/openid-connect/token",
				AuthStyle: oauth2.AuthStyleInParams,
			},
		},
		verifier: oidc.NewVerifier(cfg.Issuer, keys, &oidc.Config{ClientID: clientID}),
		store:    store,
	}
}

func mustURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		panic(err)
	}
	return u
}

func random() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (a *Auth) cookie(name, value string, maxAge int) *http.Cookie {
	return &http.Cookie{Name: name, Value: value, Path: "/audit", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: maxAge}
}

// Current は、ログイン中のセッション。なければ nil。
func (a *Auth) Current(r *http.Request) *session {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil
	}
	raw, ok, err := a.store.Get(r.Context(), "session", c.Value)
	if err != nil || !ok {
		return nil
	}
	var s session
	if json.Unmarshal(raw, &s) != nil || time.Since(s.Created) > sessionMaxAge {
		return nil
	}
	return &s
}

// Start は、ログインサーバーのログインへ送る（認可コードと PKCE）。
func (a *Auth) Start(w http.ResponseWriter, r *http.Request) {
	p := pending{State: random(), Nonce: random(), Verifier: oauth2.GenerateVerifier()}
	id := random()
	raw, _ := json.Marshal(p)
	if err := a.store.Put(r.Context(), "login", id, raw, time.Now().Add(loginMaxAge)); err != nil {
		http.Error(w, "ログインを始められない", http.StatusServiceUnavailable)
		return
	}
	http.SetCookie(w, a.cookie(loginCookie, id, int(loginMaxAge.Seconds())))
	http.Redirect(w, r, a.oauth.AuthCodeURL(p.State, oidc.Nonce(p.Nonce), oauth2.S256ChallengeOption(p.Verifier)), http.StatusFound)
}

// Callback は、戻り先。認可コードを、JWT-SVID のクライアント認証と PKCE で替え、ID トークンを確かめる。
func (a *Auth) Callback(w http.ResponseWriter, r *http.Request) error {
	c, err := r.Cookie(loginCookie)
	if err != nil {
		return fmt.Errorf("ログインの途中の情報がない")
	}
	// ログインの途中の情報は 1 回だけ使う。2 つのタスクに同時に届いても、渡すのは片方だけ
	raw, ok, err := a.store.Take(r.Context(), "login", c.Value)
	http.SetCookie(w, a.cookie(loginCookie, "", -1))
	var p pending
	if err != nil || !ok || json.Unmarshal(raw, &p) != nil || r.URL.Query().Get("state") != p.State {
		return fmt.Errorf("ログインの途中の情報が合わない")
	}
	if e := r.URL.Query().Get("error"); e != "" {
		return fmt.Errorf("ログインできない: %s", e)
	}
	assertion, err := os.ReadFile(a.cfg.JWTSVIDFile)
	if err != nil {
		return fmt.Errorf("JWT-SVID を読めない: %w", err)
	}
	token, err := a.oauth.Exchange(r.Context(), r.URL.Query().Get("code"), oauth2.VerifierOption(p.Verifier),
		oauth2.SetAuthURLParam("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-spiffe"),
		oauth2.SetAuthURLParam("client_assertion", strings.TrimSpace(string(assertion))))
	if err != nil {
		return fmt.Errorf("認可コードを替えられない: %w", err)
	}
	rawID, _ := token.Extra("id_token").(string)
	idToken, err := a.verifier.Verify(r.Context(), rawID)
	if err != nil {
		return fmt.Errorf("ID トークンを確かめられない: %w", err)
	}
	if idToken.Nonce != p.Nonce {
		return fmt.Errorf("ID トークンの nonce が違う")
	}
	var claims struct {
		Roles []string `json:"roles"`
	}
	_ = idToken.Claims(&claims)
	sid := random()
	now := time.Now()
	body, _ := json.Marshal(session{Sub: idToken.Subject, IDToken: rawID, Auditor: slices.Contains(claims.Roles, "AUDITOR"), Created: now})
	if err := a.store.Put(r.Context(), "session", sid, body, now.Add(sessionMaxAge)); err != nil {
		return fmt.Errorf("セッションを置けない: %w", err)
	}
	http.SetCookie(w, a.cookie(sessionCookie, sid, int(sessionMaxAge.Seconds())))
	http.Redirect(w, r, a.cfg.PublicOrigin+"/", http.StatusFound)
	return nil
}

// Logout は、セッションを消し、ログインサーバーのログインも終わらせる（gekko_11 の D-33）。
// 残ると、次に開いたときに、前の人のまま通ってしまう。
func (a *Auth) Logout(w http.ResponseWriter, r *http.Request) {
	hint := ""
	if s := a.Current(r); s != nil {
		hint = s.IDToken
	}
	if c, err := r.Cookie(sessionCookie); err == nil {
		_ = a.store.Delete(r.Context(), "session", c.Value)
	}
	http.SetCookie(w, a.cookie(sessionCookie, "", -1))
	q := url.Values{"client_id": {clientID}, "post_logout_redirect_uri": {a.cfg.PublicOrigin + "/"}}
	if hint != "" {
		q.Set("id_token_hint", hint)
	}
	http.Redirect(w, r, a.cfg.Issuer+"/protocol/openid-connect/logout?"+q.Encode(), http.StatusFound)
}
