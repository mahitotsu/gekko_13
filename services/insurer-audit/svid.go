package main

// SVID（spiffe-helper が書くファイル）で、相手の SPIFFE ID を確かめて mTLS で呼ぶ（段 D の D1-a2-3）。
// gekko_11 では Envoy が SVID で mTLS をかけた。gekko_13 では、SPIFFE の公式の部品（go-spiffe）の tlsconfig で、
// 相手の SPIFFE ID を握手の中で確かめる。agent のソケットは渡さないので、ファイルを読み直す源を作る。

import (
	"crypto/tls"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/spiffe/go-spiffe/v2/bundle/x509bundle"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
)

// FileSVID は、SVID のファイルを 2 秒ごとに見て、替わったら読み直す。x509svid.Source と x509bundle.Source を満たす。
type FileSVID struct {
	dir    string
	td     spiffeid.TrustDomain
	mu     sync.RWMutex
	svid   *x509svid.SVID
	bundle *x509bundle.Bundle
	stamp  time.Time
}

func NewFileSVID(dir string, td spiffeid.TrustDomain) (*FileSVID, error) {
	s := &FileSVID{dir: dir, td: td}
	deadline := time.Now().Add(2 * time.Minute)
	for {
		err := s.load()
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		time.Sleep(time.Second)
	}
	go func() {
		for range time.Tick(2 * time.Second) {
			_ = s.load()
		}
	}()
	return s, nil
}

func (s *FileSVID) path(name string) string { return filepath.Join(s.dir, name) }

func (s *FileSVID) load() error {
	info, err := os.Stat(s.path("svid.pem"))
	if err != nil {
		return err
	}
	s.mu.RLock()
	same := info.ModTime().Equal(s.stamp) && s.svid != nil
	s.mu.RUnlock()
	if same {
		return nil
	}
	svid, err := x509svid.Load(s.path("svid.pem"), s.path("svid_key.pem"))
	if err != nil {
		return err
	}
	bundle, err := x509bundle.Load(s.td, s.path("svid_bundle.pem"))
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.svid, s.bundle, s.stamp = svid, bundle, info.ModTime()
	s.mu.Unlock()
	return nil
}

func (s *FileSVID) GetX509SVID() (*x509svid.SVID, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.svid, nil
}

func (s *FileSVID) GetX509BundleForTrustDomain(td spiffeid.TrustDomain) (*x509bundle.Bundle, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.bundle.GetX509BundleForTrustDomain(td)
}

// Client は、相手の SPIFFE ID を確かめる mTLS の HTTP の呼び手。接続は使い回さない（入れ替わる前の証明書で示し続けないため）。
func (s *FileSVID) Client(expected spiffeid.ID, timeout time.Duration) *http.Client {
	cfg := tlsconfig.MTLSClientConfig(s, s, tlsconfig.AuthorizeID(expected))
	cfg.MinVersion = tls.VersionTLS13
	return &http.Client{Timeout: timeout, Transport: retryGet{&http.Transport{TLSClientConfig: cfg, DisableKeepAlives: true}}}
}

// retryGet は、本文のない GET を、応答が届く前に失敗したら、最大 6 回まで、間を 0.3 秒ずつ延ばして送り直す（段 D の D1-a3。止まったタスクへのつなぎを、
// Service Connect は救いきれなかった。2026-11-23 の AWS）。監査サービスの呼び出しは、保険会社のシステムの記録の読み取りだけである。
type retryGet struct{ next http.RoundTripper }

func (r retryGet) RoundTrip(req *http.Request) (*http.Response, error) {
	var res *http.Response
	var err error
	for i := 1; i <= 6; i++ {
		res, err = r.next.RoundTrip(req)
		if err == nil || req.Method != http.MethodGet || req.Body != nil || req.Context().Err() != nil {
			return res, err
		}
		time.Sleep(time.Duration(i) * 300 * time.Millisecond)
	}
	return res, err
}
