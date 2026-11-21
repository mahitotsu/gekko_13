-- 共有の保存先（段 D の D1-a1）に、サービスごとのデータベースとロールを作る。何度流しても同じ結果になる。
-- 管理者で流す。AWS（Aurora）では SPIRE server のタスクの db-init のコンテナ（services/db-init）が、手元では local/up.sh が流す。
-- ロールのパスワードは、psql の変数で渡す（AWS では aws/deploy.sh が作って SSM に置き、ECS が渡す）。流すたびに付け直す。
-- 2 つのタスクが同時に流しても失敗しないよう、セッションのアドバイザリーロックで順番にする（psql の 1 つのセッションで流す）。
-- 使い方: psql -v ON_ERROR_STOP=1 -v spire_password=... -v keycloak_password=... -v auth_password=... -f services/db-init/db-init.sql
SELECT pg_advisory_lock(7231000);

SELECT set_config('gekko.pw_spire', :'spire_password', false),
       set_config('gekko.pw_keycloak', :'keycloak_password', false),
       set_config('gekko.pw_auth', :'auth_password', false);

DO $$
DECLARE
  r text;
  pw text;
BEGIN
  FOREACH r IN ARRAY ARRAY['spire', 'keycloak', 'auth'] LOOP
    pw := current_setting('gekko.pw_' || r);
    IF coalesce(pw, '') = '' THEN
      RAISE EXCEPTION 'password for % is empty', r;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', r, pw);
    ELSE
      EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', r, pw);
    END IF;
    -- データベースの持ち主をこのロールにするには、作る側（管理者）が、このロールに切り替えられる必要がある（PostgreSQL 16 から）。
    -- ロールを作った者は、管理の権利（ADMIN）を持つが、切り替える権利（SET）は持たない。Aurora の管理者は本物の superuser ではないので、
    -- SET を与えてから作る（手元の superuser では要らないが、害はない）
    IF NOT pg_has_role(current_user, r, 'SET') THEN
      EXECUTE format('GRANT %I TO %I WITH SET TRUE', r, current_user);
    END IF;
  END LOOP;
END
$$;

-- CREATE DATABASE はトランザクションの中で流せないので、psql の \gexec で 1 つずつ流す。持ち主は、同じ名前のロール
SELECT format('CREATE DATABASE %I OWNER %I', d, d)
FROM unnest(ARRAY['spire', 'keycloak', 'auth']) AS d
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = d)
\gexec

SELECT pg_advisory_unlock(7231000);
