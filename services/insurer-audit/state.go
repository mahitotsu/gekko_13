package main

// 監査の担当のセッションと、ログインの途中の情報の置き場所（段 D の D1-a3。判断 53）。2 つのタスクが同じものを読むよう、
// 共有のデータベース（AWS では Aurora）に置く。キーは Cookie の値の SHA-256 にする（データベースが漏れても、セッションを乗っ取れない）。
// 試験では、メモリの実装（memState）を使う。

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type stateStore interface {
	// Get は、期限内の 1 件を返す。なければ ok が false。
	Get(ctx context.Context, kind, id string) (value []byte, ok bool, err error)
	Put(ctx context.Context, kind, id string, value []byte, expires time.Time) error
	// Take は、1 件を読んで消す。2 つのタスクが同時に読んでも、渡すのは片方だけ（ログインの途中は 1 回だけ使う）。
	Take(ctx context.Context, kind, id string) (value []byte, ok bool, err error)
	Delete(ctx context.Context, kind, id string) error
}

func keyOf(id string) string {
	sum := sha256.Sum256([]byte(id))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

type memRow struct {
	value   []byte
	expires time.Time
}

type memState struct {
	mu   sync.Mutex
	rows map[string]memRow
}

func newMemState() *memState { return &memState{rows: map[string]memRow{}} }

func (m *memState) read(k string) ([]byte, bool) {
	r, ok := m.rows[k]
	if ok && time.Now().After(r.expires) {
		delete(m.rows, k)
		return nil, false
	}
	return r.value, ok
}

func (m *memState) Get(_ context.Context, kind, id string) ([]byte, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.read(kind + ":" + keyOf(id))
	return v, ok, nil
}

func (m *memState) Put(_ context.Context, kind, id string, value []byte, expires time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[kind+":"+keyOf(id)] = memRow{value: value, expires: expires}
	return nil
}

func (m *memState) Take(_ context.Context, kind, id string) ([]byte, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := kind + ":" + keyOf(id)
	v, ok := m.read(k)
	delete(m.rows, k)
	return v, ok, nil
}

func (m *memState) Delete(_ context.Context, kind, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rows, kind+":"+keyOf(id))
	return nil
}

const schema = `
SELECT pg_advisory_lock(7231004);
CREATE TABLE IF NOT EXISTS audit_state (
  kind text NOT NULL,
  id text NOT NULL,
  value text NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (kind, id)
);
SELECT pg_advisory_unlock(7231004);
`

type pgState struct {
	pool *pgxpool.Pool
}

// newPgState は、共有のデータベースにつなぎ、表がなければ作る。url は postgres://ホスト:ポート/データベース。
// caPEM（Aurora の CA）があれば、TLS で Aurora の証明書と名前を確かめる。手元の PostgreSQL のコンテナでは、平文でつなぐ。
// どちらでも、ほかの形（TLS のない接続など）へ落ちる道は持たない。
func newPgState(ctx context.Context, url, user, password, caPEM string) (*pgState, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 5
	cfg.ConnConfig.User = user
	cfg.ConnConfig.Password = password
	cfg.ConnConfig.Fallbacks = nil
	if caPEM != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(caPEM)) {
			return nil, errors.New("Aurora の CA を読めない")
		}
		cfg.ConnConfig.TLSConfig = &tls.Config{RootCAs: pool, ServerName: cfg.ConnConfig.Host, MinVersion: tls.VersionTLS12}
	} else {
		cfg.ConnConfig.TLSConfig = nil
	}
	if t := pgxTracer(); t != nil {
		cfg.ConnConfig.Tracer = t
	}
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	// 複数の文を 1 回で流すので、引数のない単純な問い合わせにする（同じ接続で、ロックと表の作成が流れる）
	conn, err := db.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("データベースにつながらない: %w", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, schema, pgx.QueryExecModeSimpleProtocol); err != nil {
		return nil, fmt.Errorf("表を作れない: %w", err)
	}
	return &pgState{pool: db}, nil
}

func (p *pgState) Get(ctx context.Context, kind, id string) ([]byte, bool, error) {
	var v string
	err := p.pool.QueryRow(ctx, "SELECT value FROM audit_state WHERE kind = $1 AND id = $2 AND expires_at >= $3",
		kind, keyOf(id), time.Now().UnixMilli()).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	return []byte(v), err == nil, err
}

func (p *pgState) Put(ctx context.Context, kind, id string, value []byte, expires time.Time) error {
	_, err := p.pool.Exec(ctx, `INSERT INTO audit_state (kind, id, value, expires_at) VALUES ($1, $2, $3, $4)
		ON CONFLICT (kind, id) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
		kind, keyOf(id), string(value), expires.UnixMilli())
	if err == nil {
		// 期限を過ぎた行は、書くついでに消す
		_, _ = p.pool.Exec(ctx, "DELETE FROM audit_state WHERE expires_at < $1", time.Now().UnixMilli())
	}
	return err
}

func (p *pgState) Take(ctx context.Context, kind, id string) ([]byte, bool, error) {
	var v string
	var exp int64
	err := p.pool.QueryRow(ctx, "DELETE FROM audit_state WHERE kind = $1 AND id = $2 RETURNING value, expires_at",
		kind, keyOf(id)).Scan(&v, &exp)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return []byte(v), exp >= time.Now().UnixMilli(), nil
}

func (p *pgState) Delete(ctx context.Context, kind, id string) error {
	_, err := p.pool.Exec(ctx, "DELETE FROM audit_state WHERE kind = $1 AND id = $2", kind, keyOf(id))
	return err
}
