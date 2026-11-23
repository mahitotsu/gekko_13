package main

// 監査サービスを起動する（段 D の D1-a2-3）。受け口は、入口のリバースプロキシから届く平文の HTTP（APP_PORT、既定 8080）の /audit の下。
// 環境変数:
//   - ISSUER: ログインサーバーの公開の issuer。PUBLIC_ORIGIN: 監査の画面の公開の URL（/audit まで）
//   - LOGIN_ORIGIN: ログインサーバーへ送る先の origin（既定は ISSUER の origin。手元ではコンテナの名前）
//   - SVID_DIR、JWT_SVID_FILE、TRUST_DOMAIN: SVID のファイルと信頼ドメイン
//   - BACKEND_URL: 保険会社のシステム（自己申告を読む）
//   - RECORDS: 記録の出どころ。cloudwatch（既定。LOG_GROUP）か docker（手元。DOCKER_SOCKET）

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
)

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("svc", "insurer-audit"))
	ctx := context.Background()
	td := spiffeid.RequireTrustDomainFromString(env("TRUST_DOMAIN", "gekko13.internal"))
	svids, err := NewFileSVID(env("SVID_DIR", "/svid"), td)
	if err != nil {
		slog.Error("SVID を読めない", "error", err)
		os.Exit(1)
	}
	// セッションは、共有のデータベースに置く（段 D の D1-a3。state.go）。DB_URL がなければ、起動しない
	store, err := newPgState(ctx, os.Getenv("DB_URL"), env("DB_USER", "audit"), os.Getenv("DB_PASSWORD"), os.Getenv("DB_CA_PEM"))
	if err != nil {
		slog.Error("共有のデータベースを使えない", "error", err)
		os.Exit(1)
	}
	issuer := os.Getenv("ISSUER")
	auth := NewAuth(ctx, AuthConfig{
		Issuer:       issuer,
		LoginOrigin:  env("LOGIN_ORIGIN", mustURL(issuer).Scheme+"://"+mustURL(issuer).Host),
		PublicOrigin: os.Getenv("PUBLIC_ORIGIN"),
		JWTSVIDFile:  env("JWT_SVID_FILE", "/svid/jwt_svid.token"),
	}, store)
	records := Records{
		selfURL:    env("BACKEND_URL", "https://insurer-backend:9443") + "/audit/records",
		selfClient: svids.Client(spiffeid.RequireFromPath(td, "/svc/insurer-backend"), 10*time.Second),
	}
	if env("RECORDS", "cloudwatch") == "docker" {
		records.logs = DockerLogs(env("DOCKER_SOCKET", "/var/run/docker.sock"))
	} else {
		records.logs, err = CloudWatchLogs(ctx, env("LOG_GROUP", "/gekko13/ecs"))
		if err != nil {
			slog.Error("CloudWatch Logs を使えない", "error", err)
			os.Exit(1)
		}
	}
	addr := ":" + env("APP_PORT", "8080")
	slog.Info("listening", "addr", addr, "records", env("RECORDS", "cloudwatch"))
	server := &http.Server{Addr: addr, Handler: Handler("/audit", auth, records.Snapshot), ReadHeaderTimeout: 10 * time.Second}
	if err := server.ListenAndServe(); err != nil {
		slog.Error("止まった", "error", err)
		os.Exit(1)
	}
}
