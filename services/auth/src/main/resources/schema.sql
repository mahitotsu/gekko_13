-- 認可サーバーの表。認可の記録（Spring Authorization Server の JdbcOAuth2AuthorizationService のスキーマ）と、
-- 顧客が登録した連絡先、登録を外したクライアント（段 D の D1-a2）。
-- 元のスキーマの注記のとおり、PostgreSQL では blob を text にする。なければ作る。
-- 2 つのタスクが同時に起きても、表を 1 回だけ作るように、アドバイザリーロックで順番にする（同じ接続で流れる）
SELECT pg_advisory_lock(7231001);
CREATE TABLE IF NOT EXISTS oauth2_authorization (
    id varchar(100) NOT NULL,
    registered_client_id varchar(100) NOT NULL,
    principal_name varchar(200) NOT NULL,
    authorization_grant_type varchar(100) NOT NULL,
    authorized_scopes varchar(1000) DEFAULT NULL,
    attributes text DEFAULT NULL,
    state varchar(500) DEFAULT NULL,
    authorization_code_value text DEFAULT NULL,
    authorization_code_issued_at timestamp DEFAULT NULL,
    authorization_code_expires_at timestamp DEFAULT NULL,
    authorization_code_metadata text DEFAULT NULL,
    access_token_value text DEFAULT NULL,
    access_token_issued_at timestamp DEFAULT NULL,
    access_token_expires_at timestamp DEFAULT NULL,
    access_token_metadata text DEFAULT NULL,
    access_token_type varchar(100) DEFAULT NULL,
    access_token_scopes varchar(1000) DEFAULT NULL,
    oidc_id_token_value text DEFAULT NULL,
    oidc_id_token_issued_at timestamp DEFAULT NULL,
    oidc_id_token_expires_at timestamp DEFAULT NULL,
    oidc_id_token_metadata text DEFAULT NULL,
    refresh_token_value text DEFAULT NULL,
    refresh_token_issued_at timestamp DEFAULT NULL,
    refresh_token_expires_at timestamp DEFAULT NULL,
    refresh_token_metadata text DEFAULT NULL,
    user_code_value text DEFAULT NULL,
    user_code_issued_at timestamp DEFAULT NULL,
    user_code_expires_at timestamp DEFAULT NULL,
    user_code_metadata text DEFAULT NULL,
    device_code_value text DEFAULT NULL,
    device_code_issued_at timestamp DEFAULT NULL,
    device_code_expires_at timestamp DEFAULT NULL,
    device_code_metadata text DEFAULT NULL,
    PRIMARY KEY (id)
);
-- 顧客ごとの受信箱の番号（直送の宛先。gekko_11 の D-26）。端末ごとに 1 行
CREATE TABLE IF NOT EXISTS contact_inbox (
    customer varchar(200) NOT NULL,
    inbox varchar(64) NOT NULL,
    created timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (customer, inbox)
);
-- 登録を外したクライアント（gekko_11 の G4）
CREATE TABLE IF NOT EXISTS client_revocation (
    client_id varchar(100) NOT NULL PRIMARY KEY
);
SELECT pg_advisory_unlock(7231001);
