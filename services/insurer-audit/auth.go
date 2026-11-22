package main

// 監査の担当のログイン（gekko_11 の SecurityConfig。gekko_11 の D-31）。OpenID Connect の認可コードと PKCE を使い、
// クライアント認証は JWT-SVID（gekko_11 の D-38）。ID トークンは go-oidc で、公開の名前の issuer として確かめる。
// 画面と記録は、ID トークンの roles に AUDITOR がある者にだけ見せる。全ての顧客の契約と会話が出るからである。
// セッションはメモリに置く（1 タスク。冗長化は段 D の D1-a3）。Cookie は /audit の下だけに置き、顧客のアプリのセッションと分ける。

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
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
	sub     string
	idToken string
	auditor bool
	created time.Time
}

type pending struct {
	state, nonce, verifier string
	at                     time.Time
}

// Auth は、ログインとセッションを扱う。
type Auth struct {
	cfg      AuthConfig
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
	mu       sync.Mutex
	sessions map[string]session
	logins   map[string]pending
}

// NewAuth は、ログインサーバーの受け口を 1 つずつ決める。公開の名前と、取りに行く先が違うことがあるので、発見の文書は使わない。
func NewAuth(ctx context.Context, cfg AuthConfig) *Auth {
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
		sessions: map[string]session{},
		logins:   map[string]pending{},
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
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[c.Value]
	if !ok || time.Since(s.created) > sessionMaxAge {
		delete(a.sessions, c.Value)
		return nil
	}
	return &s
}

// Start は、ログインサーバーのログインへ送る（認可コードと PKCE）。
func (a *Auth) Start(w http.ResponseWriter, r *http.Request) {
	p := pending{state: random(), nonce: random(), verifier: oauth2.GenerateVerifier(), at: time.Now()}
	id := random()
	a.mu.Lock()
	for k, v := range a.logins {
		if time.Since(v.at) > 10*time.Minute {
			delete(a.logins, k)
		}
	}
	a.logins[id] = p
	a.mu.Unlock()
	http.SetCookie(w, a.cookie(loginCookie, id, 600))
	http.Redirect(w, r, a.oauth.AuthCodeURL(p.state, oidc.Nonce(p.nonce), oauth2.S256ChallengeOption(p.verifier)), http.StatusFound)
}

// Callback は、戻り先。認可コードを、JWT-SVID のクライアント認証と PKCE で替え、ID トークンを確かめる。
func (a *Auth) Callback(w http.ResponseWriter, r *http.Request) error {
	c, err := r.Cookie(loginCookie)
	if err != nil {
		return fmt.Errorf("ログインの途中の情報がない")
	}
	a.mu.Lock()
	p, ok := a.logins[c.Value]
	delete(a.logins, c.Value)
	a.mu.Unlock()
	http.SetCookie(w, a.cookie(loginCookie, "", -1))
	if !ok || r.URL.Query().Get("state") != p.state {
		return fmt.Errorf("ログインの途中の情報が合わない")
	}
	if e := r.URL.Query().Get("error"); e != "" {
		return fmt.Errorf("ログインできない: %s", e)
	}
	assertion, err := os.ReadFile(a.cfg.JWTSVIDFile)
	if err != nil {
		return fmt.Errorf("JWT-SVID を読めない: %w", err)
	}
	token, err := a.oauth.Exchange(r.Context(), r.URL.Query().Get("code"), oauth2.VerifierOption(p.verifier),
		oauth2.SetAuthURLParam("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-spiffe"),
		oauth2.SetAuthURLParam("client_assertion", strings.TrimSpace(string(assertion))))
	if err != nil {
		return fmt.Errorf("認可コードを替えられない: %w", err)
	}
	raw, _ := token.Extra("id_token").(string)
	idToken, err := a.verifier.Verify(r.Context(), raw)
	if err != nil {
		return fmt.Errorf("ID トークンを確かめられない: %w", err)
	}
	if idToken.Nonce != p.nonce {
		return fmt.Errorf("ID トークンの nonce が違う")
	}
	var claims struct {
		Roles []string `json:"roles"`
	}
	_ = idToken.Claims(&claims)
	sid := random()
	a.mu.Lock()
	a.sessions[sid] = session{sub: idToken.Subject, idToken: raw, auditor: slices.Contains(claims.Roles, "AUDITOR"), created: time.Now()}
	a.mu.Unlock()
	http.SetCookie(w, a.cookie(sessionCookie, sid, int(sessionMaxAge.Seconds())))
	http.Redirect(w, r, a.cfg.PublicOrigin+"/", http.StatusFound)
	return nil
}

// Logout は、セッションを消し、ログインサーバーのログインも終わらせる（gekko_11 の D-33）。
// 残ると、次に開いたときに、前の人のまま通ってしまう。
func (a *Auth) Logout(w http.ResponseWriter, r *http.Request) {
	hint := ""
	if c, err := r.Cookie(sessionCookie); err == nil {
		a.mu.Lock()
		hint = a.sessions[c.Value].idToken
		delete(a.sessions, c.Value)
		a.mu.Unlock()
	}
	http.SetCookie(w, a.cookie(sessionCookie, "", -1))
	q := url.Values{"client_id": {clientID}, "post_logout_redirect_uri": {a.cfg.PublicOrigin + "/"}}
	if hint != "" {
		q.Set("id_token_hint", hint)
	}
	http.Redirect(w, r, a.cfg.Issuer+"/protocol/openid-connect/logout?"+q.Encode(), http.StatusFound)
}
