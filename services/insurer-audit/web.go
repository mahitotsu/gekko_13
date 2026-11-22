package main

// 監査の画面（契約の一覧と、契約ごとの突き合わせ）と、同じ中身の JSON の受け口（gekko_11 の AuditController）。
// 入口のリバースプロキシが /audit の下を送る。役割が監査の者だけが使える。

import (
	"embed"
	"encoding/json"
	"html/template"
	"log/slog"
	"net/http"
	"strings"
)

//go:embed templates/*.html
var templateFiles embed.FS

//go:embed assets/*
var assetFiles embed.FS

const listLimit = 30

var pages = template.Must(template.New("").Funcs(template.FuncMap{
	"pretty": func(v any) string {
		b, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			return ""
		}
		return string(b)
	},
}).ParseFS(templateFiles, "templates/*.html"))

// page は、テンプレートに渡す値。
type page struct {
	Title     string
	Base      string
	User      string
	Contracts []Summary
	Report    *Report
}

// Handler は、/audit の下の受け口を組み立てる。
// source は、要求ごとに出どころを作る（1 つの要求の間だけ、読んだ記録を使い回す）。
func Handler(base string, auth *Auth, source func() Source) http.Handler {
	mux := http.NewServeMux()
	render := func(w http.ResponseWriter, status int, name string, p page) {
		p.Base = base
		w.Header().Set("content-type", "text/html; charset=utf-8")
		// 画面でコードを動かされたときの第 2 の守り（顧客のアプリと同じ）。スクリプトは使わない
		w.Header().Set("content-security-policy", "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
		w.WriteHeader(status)
		if err := pages.ExecuteTemplate(w, name, p); err != nil {
			slog.Error("画面を作れない", "error", err)
		}
	}
	// 役割が監査の者だけを通す。ログインしていなければ、ログインサーバーへ送る
	guard := func(next func(http.ResponseWriter, *http.Request, *session)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			s := auth.Current(r)
			if s == nil {
				if strings.HasPrefix(r.URL.Path, "/api/") {
					http.Error(w, `{"error":"ログインしていない"}`, http.StatusUnauthorized)
					return
				}
				auth.Start(w, r)
				return
			}
			if !s.auditor {
				render(w, http.StatusForbidden, "forbidden.html", page{Title: "見られません", User: s.sub})
				return
			}
			next(w, r, s)
		}
	}
	fail := func(w http.ResponseWriter, err error) {
		slog.Error("突き合わせができない", "error", err)
		http.Error(w, "突き合わせができない: "+err.Error(), http.StatusBadGateway)
	}

	mux.Handle("GET /assets/", http.FileServerFS(assetFiles))
	mux.HandleFunc("GET "+callbackPath, func(w http.ResponseWriter, r *http.Request) {
		if err := auth.Callback(w, r); err != nil {
			slog.Warn("ログインできない", "error", err)
			http.Error(w, err.Error(), http.StatusUnauthorized)
		}
	})
	mux.HandleFunc("POST /logout", auth.Logout)
	mux.HandleFunc("GET /{$}", guard(func(w http.ResponseWriter, r *http.Request, s *session) {
		list, err := Reconciler{Source: source()}.List(listLimit)
		if err != nil {
			fail(w, err)
			return
		}
		render(w, http.StatusOK, "contracts.html", page{Title: "契約の一覧", User: s.sub, Contracts: list})
	}))
	mux.HandleFunc("GET /contracts/{nonce}", guard(func(w http.ResponseWriter, r *http.Request, s *session) {
		report, err := Reconciler{Source: source()}.Reconcile(r.PathValue("nonce"))
		if err != nil {
			fail(w, err)
			return
		}
		if report == nil {
			http.Error(w, "その nonce の契約がない", http.StatusNotFound)
			return
		}
		render(w, http.StatusOK, "contract.html", page{Title: "契約の突き合わせ", User: s.sub, Report: report})
	}))
	mux.HandleFunc("GET /api/contracts", guard(func(w http.ResponseWriter, r *http.Request, _ *session) {
		list, err := Reconciler{Source: source()}.List(listLimit)
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}))
	mux.HandleFunc("GET /api/contracts/{nonce}", guard(func(w http.ResponseWriter, r *http.Request, _ *session) {
		report, err := Reconciler{Source: source()}.Reconcile(r.PathValue("nonce"))
		if err != nil {
			fail(w, err)
			return
		}
		if report == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "その nonce の契約がない"})
			return
		}
		writeJSON(w, http.StatusOK, struct {
			*Report
			Groups []Group `json:"groups"`
		}{report, report.Groups()})
	}))
	// 入口のリバースプロキシは、/audit を付けたまま送る。/audit（末尾のスラッシュなし）は /audit/ へ送る。
	// StripPrefix のあとのパスが空になり、ServeMux が「/」へ送り直すと、顧客のアプリへ行ってしまうため
	stripped := http.StripPrefix(base, mux)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == base {
			http.Redirect(w, r, base+"/", http.StatusFound)
			return
		}
		stripped.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
