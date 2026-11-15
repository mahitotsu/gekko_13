# 実機で確かめた事実

**この文書の読み手:** SPIRE の身元の配り方、mTLS の拒み方、SVID の入れ替え、Cognito の設定について、個別の事実を調べに来た開発者と AI エージェント。検証の計画と合格の基準は [plan.md](plan.md)、経過は [log.md](log.md)。用語は [用語集](glossary.md)。

各項目は、**結論**（見出しと数行）と、**根拠**（コマンド・出典・取得日）に分けて書く。1〜3 節はローカルの docker で 2026-11-15 に確かめた。環境は次のとおり。

| 部品 | 版 |
|---|---|
| OS | WSL2（Linux 6.18） |
| Docker | 29.1.3（cgroup v2） |
| SPIRE | 1.15.3 |
| spiffe-helper | 0.11.0 |
| Node.js | 24.21.0 |
AWS の段はまだ行っていない（[5 節](#5-未確認)）。

## 一覧
| 項目 | 確かめた事実 |
|---|---|
| 1-1 | docker の attestor は、ECS と同じ名前のラベルで、ファミリーごとに別の SPIFFE ID を配った |
| 1-2 | 登録していないファミリーのコンテナには、SVID が出なかった |
| 1-3 | ラベルを偽ったコンテナにも、SVID が出た |
| 1-4 | 有効期限 300 秒の SVID は、約 2.5 分ごとに入れ替わった |
| 2-1 | アプリが終える mTLS は、証明書なしと、SPIRE 以外の認証局の証明書を、TLS で拒んだ |
| 2-2 | 呼ぶ側は、相手の SPIFFE ID が違えば、接続を止めた |
| 2-3 | 受け取る側は、SPIFFE ID とトークンの呼び出し元が対応しないとき、403 で拒んだ |
| 3-1 | 30 分の連鎖の呼び出し 1,764 回は、SVID の入れ替えを 13 回挟んで、失敗 0 件だった |
| 4-1 | Cognito の token exchange（委任）は、app client の `ExplicitAuthFlows` で許す |
| 4-2 | 委任のトークンの形は、ドキュメントの例と gekko_12 の実測で食い違う |
| 4-3 | cfn-lint 1.60.1 と AWS CLI 2.38.1 は、token exchange のフローの値をまだ知らない |
| 4-4 | `RUN` のない Dockerfile なら、エミュレーションなしで arm64 のイメージを作れた |

## 1. SPIRE の身元の配り方
### 1-1. docker の attestor は、ECS と同じ名前のラベルで、ファミリーごとに別の SPIFFE ID を配った
**結論:** 各コンテナに `com.amazonaws.ecs.task-definition-family` と `com.amazonaws.ecs.container-name` のラベルを付けた。登録のセレクターをこの 2 つの組にすると、bff、transfer、ledger の svid-helper に、それぞれの SPIFFE ID の SVID が出た。agent は cgroup の名前空間を分けたまま（ホストのものを使わずに）、ホストの PID からコンテナを見分けた。ECS のタスクでは cgroup の名前空間を設定できないので、AWS でも同じ形で動く見込みがある（推定）。

<details>
<summary>根拠</summary>

- コマンド: `local/up.sh` のあと `openssl x509 -in local/run/svid/<サービス>/svid.pem -noout -ext subjectAltName`
- 結果: `URI:spiffe://gekko13.internal/svc/bff`、`.../transfer`、`.../ledger`。シナリオ 1-a が期待どおり。
- agent のコンテナは `--pid host` と docker のソケット（読むだけ）で動かした。`--cgroupns host` は付けていない。

</details>

### 1-2. 登録していないファミリーのコンテナには、SVID が出なかった
**結論:** ファミリーのラベルを `gekko13-rogue` にした svid-helper には、20 秒待っても SVID が出なかった。agent は `No identity issued`（`registered=false`）を記録した。

<details>
<summary>根拠</summary>

- コマンド: `node scripts/scenarios.ts --target local`（シナリオ 1-b）、`docker logs gekko13-spire-agent`
- 結果: シナリオ 1-b が期待どおり。agent の記録に、`msg="No identity issued" method=FetchX509SVID registered=false` が 2 回の実行で 6 件ずつ出た。

</details>

### 1-3. ラベルを偽ったコンテナにも SVID が出る
**結論:** 同じホストで `docker run` に ledger のラベルを付けた svid-helper に、ledger の SVID が出た。docker の attestor はラベルだけで見分けるので、ホストで docker を操作できる者は、どのサービスの身元も得られる。これは予測どおりで、残るリスクとして扱う。ECS では、タスク定義の登録（`ecs:RegisterTaskDefinition`）とホストへのログインの権限で守る必要がある。

<details>
<summary>根拠</summary>

- コマンド: `node scripts/scenarios.ts --target local`（シナリオ 1-c）
- 結果: `spiffe://gekko13.internal/svc/ledger` の SVID が出た。

</details>

### 1-4. 有効期限 300 秒の SVID は、約 2.5 分ごとに入れ替わった
**結論:** 登録で `-x509SVIDTTL 300` を指定した SVID の有効期間は、5 分 10 秒だった（開始の時刻が 10 秒前に置かれる）。agent は、有効期間の半分ほどで新しい SVID を出し、spiffe-helper がファイルを書き換えた。起動の直後は、agent が登録を同期するまで `No identity issued` を返すことがあり、spiffe-helper は問い合わせを繰り返して数秒のうちに SVID を得た（推定。記録の PID と、svid-helper のコンテナの対応は確かめていない）。

<details>
<summary>根拠</summary>

- コマンド: `openssl x509 -noout -startdate -enddate`、`node scripts/soak.ts`
- 結果: `notBefore=13:39:47`、`notAfter=13:44:57`（UTC）。入れ替えの間隔は 2 分 20 秒〜2 分 30 秒ほど。

</details>

## 2. mTLS とトークンの照合
### 2-1. アプリが終える mTLS は、証明書なしと、SPIRE 以外の認証局の証明書を、TLS で拒んだ
**結論:** Node.js の HTTPS の受け口（`requestCert` と `rejectUnauthorized`、信頼するのは SPIRE のバンドルだけ）は、証明書を示さない接続を TLS 1.3 の警告で拒んだ。別の信頼ドメインの証明書と、同じ SPIFFE ID を名乗る別の認証局の証明書は、接続を切った。どちらもアプリの処理には届かなかった。

<details>
<summary>根拠</summary>

- コマンド: `node scripts/scenarios.ts --target local`（シナリオ 3-b、3-e、3-e2）
- 結果: 3-b は `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`。3-e と 3-e2 は `ECONNRESET`。

</details>

### 2-2. 呼ぶ側は、相手の SPIFFE ID が違えば、接続を止めた
**結論:** 呼ぶ側は、ホスト名ではなく、相手の証明書の SPIFFE ID を確かめる（`checkServerIdentity`）。transfer のつもりで ledger につなぐと、要求を送る前に接続を止めた。SVID には DNS の SAN がないので、Node.js の既定のホスト名の確認は使えない。

<details>
<summary>根拠</summary>

- コマンド: `node scripts/scenarios.ts --target local`（シナリオ 3-g）
- 結果: `相手の SPIFFE ID が違う: spiffe://gekko13.internal/svc/ledger`

</details>

### 2-3. 受け取る側は、SPIFFE ID とトークンの呼び出し元が対応しないとき、403 で拒んだ
**結論:** ledger は、相手の SPIFFE ID に対応する client、トークンの `client_id`、`act.client_id` の 3 つが一致したときだけ記帳した。transfer の鍵で BFF が交換したトークンを送ると、`peer_actor_mismatch` で拒んだ。BFF の鍵で直接呼ぶと、`caller_not_allowed` で拒んだ。トークンの発行者は模擬なので、本物の Cognito のトークンで同じになるかは確かめていない。

<details>
<summary>根拠</summary>

- コマンド: `node scripts/scenarios.ts --target local`（シナリオ 3-a、3-c、3-d、3-f）
- 結果: 3-a は 200、3-c と 3-d は 403、3-f（トークンなし）は 401。2 回の実行で同じ結果だった。

</details>

## 3. SVID の入れ替え
### 3-1. 30 分の連鎖の呼び出し 1,764 回は、SVID の入れ替えを 13 回挟んで、失敗 0 件だった
**結論:** BFF → transfer → ledger の連鎖を 1 秒の間隔で 30 分呼び続けた。その間に、3 つのサービスの SVID がそれぞれ 13 回入れ替わり、失敗は 0 件だった。受け口は、入れ替わるたびに新しい証明書へ差し替えた（`setSecureContext`）。呼ぶ側は要求ごとに接続をつなぎ直すので、古い証明書で示し続けることがない。

<details>
<summary>根拠</summary>

- コマンド: `node scripts/soak.ts 30 1000`（2026-11-15 13:42〜14:12 UTC）、`docker logs gekko13-<サービス> | grep -c svid_rotated`
- 結果: 成功 1,764 件、失敗 0 件、入れ替えは各 13 回。各アプリの `svid_rotated` の記録は 13 件、エラーの記録は 0 件。

</details>

## 4. Cognito の設定とイメージ
### 4-1. Cognito の token exchange（委任）は、app client の ExplicitAuthFlows で許す
**結論:** ドキュメントによると、token exchange は Essentials か Plus の機能である。app client の認証フローに `ALLOW_TOKEN_EXCHANGE_DELEGATION`（委任）か `ALLOW_TOKEN_EXCHANGE_IMPERSONATION`（なりすまし）を入れて許す。委任は、要求に `actor_token` と `actor_token_type` を加えて選ぶ。CloudFormation で設定が通るかは確かめていない。

<details>
<summary>根拠</summary>

- 出典: [Exchanging tokens for downstream services](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-token-exchange.html)（取得日 2026-11-15）
- 結果: CloudFormation の `AWS::Cognito::UserPoolClient` の型（`aws cloudformation describe-type`、2026-11-15）には token exchange の専用の項目がなく、`ExplicitAuthFlows` は値を限らない文字列の配列だった。

</details>

### 4-2. 委任のトークンの形は、ドキュメントの例と gekko_12 の実測で食い違う
**結論:** ドキュメントの例では、`act` は `{"sub": "<呼び出し元の client ID>"}` で、`client_id` のクレームはない。scope は、要求、交換元、client の許可の 3 つの共通部分が出る。gekko_12 の実測（1-2、1-5）では、`act.client_id` と `client_id` があり、許されない scope は削らずに拒まれた。この検証のコードは実測に合わせた。どちらが本物の挙動かは、AWS の段の実行役が残すトークンの形で決める。

<details>
<summary>根拠</summary>

- 出典: 4-1 と同じページ（取得日 2026-11-15）。gekko_12 の `docs/research/aws-findings.md` の 1-2 と 1-5（2026-11-13〜15 の実測）。

</details>

### 4-3. cfn-lint 1.60.1 と AWS CLI 2.38.1 は、token exchange のフローの値をまだ知らない
**結論:** cfn-lint は `ALLOW_TOKEN_EXCHANGE_DELEGATION` を `ExplicitAuthFlows` の値として認めず、E3030 を出した。AWS CLI のヘルプにも、この値はなかった。`aws/cognito.yaml` では、該当する 2 つの資源だけ E3030 を外した。

<details>
<summary>根拠</summary>

- コマンド: `cfn-lint --regions ap-northeast-1 -- aws/*.yaml`、`aws cognito-idp create-user-pool-client help`
- 結果: `E3030 'ALLOW_TOKEN_EXCHANGE_DELEGATION' is not one of [...]`。外したあとは、4 つのテンプレートで誤り 0 件。

</details>

### 4-4. RUN のない Dockerfile なら、エミュレーションなしで arm64 のイメージを作れた
**結論:** この環境の buildx には arm64 のエミュレーション（QEMU）がない。依存（`jose`。純粋な JavaScript）をホストで入れて写し、Dockerfile から `RUN` をなくすと、`--platform linux/arm64` のイメージを作れた。

<details>
<summary>根拠</summary>

- コマンド: `docker buildx build --platform linux/arm64 -f Dockerfile <scripts/stage-image.sh の出力>`
- 結果: イメージができた。`docker buildx ls` の対応は `linux/amd64 (+3)` で、arm64 の実行は含まない。

</details>

## 5. 未確認
- CloudFormation が `ALLOW_TOKEN_EXCHANGE_DELEGATION` を受け付けるか。`aws/deploy.sh` で Cognito のスタックを作って確かめる。
- 本物の Cognito の委任のトークンの形（4-2）。`aws/run-scenarios.sh` のログの `CLAIMS` の行で確かめる。
- リフレッシュで得たアクセストークンを、交換元にできるか。シナリオ 3-a で分かる。
- ECS のエージェントが、コンテナに 1-1 と同じラベルを付けるか。AWS のシナリオ 1-a で確かめる。
- aws_iid のノードの確認が、タグのセレクターで通るか。インスタンスの上で `spire-server agent list` を実行して確かめる。
- IPv6 だけで、ECS、ECR、CloudWatch Logs、Cognito、EC2 の API に届くか。届かなければ、公開 IPv4 を付けて作り直す（[runbook.md](runbook.md#つまずきやすい点)）。
- ECS 用の AMI のルートの容量が 30 GB で足りるか、小さくできるか。
