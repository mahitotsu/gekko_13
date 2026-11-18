# 実機で確かめた事実

**この文書の読み手:** 実機で確かめた個別の事実を調べに来た開発者と AI エージェント。扱うのは、SPIRE の身元の配り方、mTLS の拒み方、SVID の入れ替え、Cognito の設定、AWS の段の作成。検証の計画と合格の基準は [plan.md](plan.md)、経過は [log.md](log.md)。用語は [用語集](../glossary.md)。

**仮置き:** これは第 1 部（内部の mTLS の基盤）の文書で、第 2 部が完成したら消す。第 2 部で要る事実と判断は、第 2 部の文書へ移す。

各項目は、**結論**（見出しと数行）と、**根拠**（コマンド・出典・取得日）に分けて書く。1〜3 節はローカルの docker で 2026-11-15 に確かめた。環境は次のとおり。

| 部品 | 版 |
|---|---|
| OS | WSL2（Linux 6.18） |
| Docker | 29.1.3（cgroup v2） |
| SPIRE | 1.15.3 |
| spiffe-helper | 0.11.0 |
| Node.js | 24.21.0 |

5〜7 節は、AWS の東京リージョンで 2026-11-16〜18 に、AWS CLI 2.38.1 で確かめた。7-4〜7-6 は段 B（2 つの AZ、各サービス 2 タスク）の結果。未確認の点は [8 節](#8-未確認)。

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
| 5-1 | CloudFormation は、テンプレートの ASCII 以外の文字を「?」に置き換えた |
| 5-2 | CloudFormation は、`ExplicitAuthFlows` の `ALLOW_TOKEN_EXCHANGE_DELEGATION` を受け付けた |
| 5-3 | `ip6tables` を書いた `daemon.json` で、ECS 用の AMI の docker が起動しなかった |
| 5-4 | 既定の AWS の名前は IPv4 だけで、デュアルスタックの名前に向けると、公開 IPv4 なしで動いた |
| 5-5 | ECS は、タスク定義の `awslogs-endpoint` を受け付けなかった |
| 5-6 | 作成中に巻き戻すと、Cloud Map の名前空間がスタックの外に残った |
| 5-7 | CloudFormation は、YAML のエイリアスを受け付けなかった |
| 5-8 | AWS CLI 2.38.1 は、標準入力からの値の渡し方の一部で失敗し、`--output text` は末尾に改行を付けた |
| 6-1 | agent の DAEMON だけが残った台を、マネージドスケーリングは空として縮めた |
| 6-2 | 0 台から起こすとき、マネージドスケーリングは 2 台を起こした |
| 6-3 | 台を 0 にして起こし直しても、EFS の上の SPIRE の CA と登録は残った |
| 6-4 | aws_iid のノードの確認は、インスタンスのタグのセレクターで通った |
| 6-5 | server が 5 分ほどいないと、agent は自分の SVID が切れて止まった |
| 6-6 | SPIRE server を冗長にするには、全部の server が 1 つの SQL のデータストアを共有する。DynamoDB は使えない |
| 6-7 | Aurora Serverless v2 は 0 ACU まで縮み、つながりが 1 本でもあると止まらない |
| 7-1 | AWS でも、シナリオは 10/10 件が期待どおりだった |
| 7-2 | 本物の委任のトークンは、`act` に `sub` と `client_id` の両方を持っていた |
| 7-3 | AWS でも、30 分の連鎖の呼び出し 1,404 回は、SVID の入れ替えを 12〜13 回挟んで、失敗 0 件だった |
| 7-4 | 段 B で、ECS は各サービスの 2 タスクを 2 つの AZ に分けて置き、シナリオは 11/11 件が期待どおりだった |
| 7-5 | 段 B でも、30 分の連鎖の呼び出し 1,403 回は、各タスクで SVID の入れ替えを 13 回以上挟んで、失敗 0 件だった |
| 7-6 | SPIRE server を別の AZ へ移すと、server は 24 秒いなかったが、連鎖の失敗は 0 件で、CA も変わらなかった |

## 1. SPIRE の身元の配り方
### 1-1. docker の attestor は、ECS と同じ名前のラベルで、ファミリーごとに別の SPIFFE ID を配った
第 2 部の [findings 1-1](../findings.md#1-1-docker-の-attestor-はecs-と同じ名前のラベルでファミリーごとに別の-spiffe-id-を配った) へ移した。

### 1-2. 登録していないファミリーのコンテナには、SVID が出なかった
第 2 部の [findings 1-2](../findings.md#1-2-登録していないファミリーのコンテナにはsvid-が出なかった) へ移した。

### 1-3. ラベルを偽ったコンテナにも SVID が出る
第 2 部の [findings 1-3](../findings.md#1-3-ラベルを偽ったコンテナにも-svid-が出る) へ移した。

### 1-4. 有効期限 300 秒の SVID は、約 2.5 分ごとに入れ替わった
第 2 部の [findings 1-4](../findings.md#1-4-有効期限-300-秒の-svid-は約-25-分ごとに入れ替わった) へ移した。

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
第 2 部の [findings 2-8](../findings.md#2-8-run-のない-dockerfile-ならエミュレーションなしで-arm64-のイメージを作れた) へ移した。

## 5. AWS の段の作成
### 5-1. CloudFormation は、テンプレートの ASCII 以外の文字を「?」に置き換えた
第 2 部の [findings 2-1](../findings.md#2-1-cloudformation-はテンプレートの-ascii-以外の文字をに置き換えた) へ移した。

### 5-2. CloudFormation は、ExplicitAuthFlows の ALLOW_TOKEN_EXCHANGE_DELEGATION を受け付けた
**結論:** Cognito のスタックは作成に成功し、BFF と transfer の client の認証フローに `ALLOW_TOKEN_EXCHANGE_DELEGATION` が入った。4-1 で確かめていなかった、CloudFormation で設定が通るかの点は、これで決まった。交換が実際に動くかは、シナリオ 3-a で確かめる。

<details>
<summary>根拠</summary>

- コマンド: `aws cognito-idp describe-user-pool-client --query 'UserPoolClient.ExplicitAuthFlows'`（秘密を出さないように、この欄だけを読んだ）
- 結果: 2 つの client とも `ALLOW_REFRESH_TOKEN_AUTH` と `ALLOW_TOKEN_EXCHANGE_DELEGATION`。

</details>

### 5-3. ip6tables を書いた daemon.json で、ECS 用の AMI の docker が起動しなかった
第 2 部の [findings 2-2](../findings.md#2-2-ip6tables-を書いた-daemonjson-でecs-用の-ami-の-docker-が起動しなかった) へ移した。

### 5-4. 既定の AWS の名前は IPv4 だけで、デュアルスタックの名前に向けると、公開 IPv4 なしで動いた
第 2 部の [findings 2-3](../findings.md#2-3-既定の-aws-の名前は-ipv4-だけでデュアルスタックの名前に向けると公開-ipv4-なしで動いた) へ移した。

### 5-5. ECS は、タスク定義の awslogs-endpoint を受け付けなかった
第 2 部の [findings 2-4](../findings.md#2-4-ecs-はタスク定義の-awslogs-endpoint-を受け付けなかった) へ移した。

### 5-6. 作成中に巻き戻すと、Cloud Map の名前空間がスタックの外に残った
第 2 部の [findings 2-5](../findings.md#2-5-作成中に巻き戻すとcloud-map-の名前空間がスタックの外に残った) へ移した。

### 5-7. CloudFormation は、YAML のエイリアスを受け付けなかった
第 2 部の [findings 2-6](../findings.md#2-6-cloudformation-はyaml-のエイリアスを受け付けなかった) へ移した。

### 5-8. AWS CLI 2.38.1 は、標準入力からの値の渡し方の一部で失敗し、--output text は末尾に改行を付けた
第 2 部の [findings 2-7](../findings.md#2-7-aws-cli-2381-は標準入力からの値の渡し方の一部で失敗し--output-text-は末尾に改行を付けた) へ移した。

## 6. AWS の段のスケールと身元
6 節と 7 節は、コミット `ae821af` と `1bc38a8` の作りで確かめた。台は ECS のキャパシティプロバイダー（マネージドスケーリング、0〜2 台、t4g.small）が決める。アプリどうしは Service Connect で呼び、SPIRE server は awsvpc で動き、状態を EFS に置く。

### 6-1. agent の DAEMON だけが残った台を、マネージドスケーリングは空として縮めた
第 2 部の [findings 3-1](../findings.md#3-1-agent-の-daemon-だけが残った台をマネージドスケーリングは空として縮めた) へ移した。

### 6-2. 0 台から起こすとき、マネージドスケーリングは 2 台を起こした
第 2 部の [findings 3-2](../findings.md#3-2-0-台から起こすときマネージドスケーリングは-2-台を起こした) へ移した。

### 6-3. 台を 0 にして起こし直しても、EFS の上の SPIRE の CA と登録は残った
第 2 部の [findings 3-3](../findings.md#3-3-台を-0-にして起こし直してもefs-の上の-spire-の-ca-と登録は残った) へ移した。

### 6-4. aws_iid のノードの確認は、インスタンスのタグのセレクターで通った
第 2 部の [findings 1-5](../findings.md#1-5-aws_iid-のノードの確認はインスタンスのタグのセレクターで通った) へ移した。

### 6-5. server が 5 分ほどいないと、agent は自分の SVID が切れて止まった
第 2 部の [findings 3-4](../findings.md#3-4-server-が-5-分ほどいないとagent-は自分の-svid-が切れて止まった) へ移した。

### 6-6. SPIRE server を冗長にするには、全部の server が 1 つの SQL のデータストアを共有する。DynamoDB は使えない
第 2 部の [findings 3-6](../findings.md#3-6-spire-server-を冗長にするには全部の-server-が-1-つの-sql-のデータストアを共有するdynamodb-は使えない) へ移した。

### 6-7. Aurora Serverless v2 は 0 ACU まで縮み、つながりが 1 本でもあると止まらない
第 2 部の [findings 3-7](../findings.md#3-7-aurora-serverless-v2-は-0-acu-まで縮みつながりが-1-本でもあると止まらない) へ移した。

## 7. AWS のシナリオ
### 7-1. AWS でも、シナリオは 10/10 件が期待どおりだった
**結論:** AWS で、1-a、1-b、3-a〜3-g が期待どおりになった。攻撃する側は、乗っ取られたタスクを演じるプローブで、本物のファミリーの別の版として動き、自分の svid-helper が得た SVID だけを使う。1-b は、登録していないファミリーの rogue のタスクで確かめた。1-c はホストのシェルが要るので対象外。サービスは 2 台に分かれて置かれ、BFF → transfer → ledger の連鎖は、台をまたいで Service Connect を通った。シナリオ 2（入れ替え）の AWS の結果は、7-3 にある。

<details>
<summary>根拠</summary>

- コマンド: `aws/run-scenarios.sh`（2026-11-17 0:33）
- 結果: `10/10 件が期待どおり（対象外 1 件）`。3-a は本物の Cognito の token exchange で 200。3-c は `403 peer_actor_mismatch`、3-d は `403 caller_not_allowed`。3-b、3-e、3-e2、3-g は TLS の段階で切れた。

</details>

### 7-2. 本物の委任のトークンは、act に sub と client_id の両方を持っていた
**結論:** BFF が交換したトークンは、外側の `client_id` が BFF、`act` が `{sub, client_id, iss, token_type}` で、`act.sub` と `act.client_id` はどちらも BFF だった。`sub` は利用者のままで、scope は求めた `banking/transfer` だけになった。4-2 の食い違いは、ドキュメントの例（`act.sub`）と gekko_12 の実測（`act.client_id`）の両方が入っている形で決まった。今のコードの照合（`act.client_id`）は、このトークンで働いた。リフレッシュで得たアクセストークンも、交換元にできた。

<details>
<summary>根拠</summary>

- 結果: プローブの transfer の役のログの `CLAIMS` の行。値は伏せ、どの client を指すかだけを、Cognito のスタックの出力と比べた。

</details>

### 7-3. AWS でも、30 分の連鎖の呼び出し 1,404 回は、SVID の入れ替えを 12〜13 回挟んで、失敗 0 件だった
**結論:** 段 A の作り（1 AZ、2 台、各サービス 1 タスク）で、プローブの bff の役が、BFF → transfer → ledger の連鎖を 1 秒の間隔で 30 分呼び続けた。その間に、有効期限 300 秒の SVID が、本物の bff で 12 回、transfer と ledger で 13 回入れ替わり、失敗は 0 件だった。連鎖は Service Connect を通り、2 台のどちらかをまたいだ。ローカルの 3-1 と同じ結果で、2 台の作りと Service Connect の中継でも、入れ替えで通信が切れなかった。これは 1 つの AZ での結果で、2 つの AZ に複数のタスクを置いたとき（段 B）は確かめていない。

<details>
<summary>根拠</summary>

- コマンド: `aws/run-scenarios.sh soak 30`（2026-11-17 22:37:30〜23:07:31 JST）
- 結果: `成功 1404 回、失敗 0 件。入れ替え bff 12 回、transfer 13 回、ledger 13 回（10 回以上が基準）。`。回数は、試験の時間の中の、各サービスのアプリのログの `svid_rotated` を数えた（`scripts/aws-collect.ts`）。
- 途中の 3 分ごとの集計でも、失敗は一度も出なかった。台は 2 台とも ap-northeast-1a だった。

</details>

### 7-4. 段 B で、ECS は各サービスの 2 タスクを 2 つの AZ に分けて置き、シナリオは 11/11 件が期待どおりだった
**結論:** 2 つの AZ のサブネットに台を置き、bff、transfer、ledger を各 2 タスクにした。マネージドスケーリングは、ap-northeast-1a と ap-northeast-1c に 1 台ずつ起こした。ECS は、置き方を指定しなくても、各サービスの 2 タスクを 2 つの AZ に 1 つずつ置いた（B-1）。この配置で、段 A と同じ 10 件のシナリオも期待どおりになった（B-2）。Service Connect は 2 つの AZ のタスクに振り分け、mTLS とトークンの照合は、どちらに届いても同じように働いた。

<details>
<summary>根拠</summary>

- コマンド: `GEKKO13_AZS=2 GEKKO13_TASKS=2 GEKKO13_MAX_HOSTS=4 aws/deploy.sh <接頭辞>`、`aws/run-scenarios.sh`（2026-11-17 23:54〜23:56 JST、コミット `7ae152e`）
- 結果: タスクの置き場所は、どのサービスも ap-northeast-1a と ap-northeast-1c に 1 つずつ。`11/11 件が期待どおり（対象外 1 件）。`

</details>

### 7-5. 段 B でも、30 分の連鎖の呼び出し 1,403 回は、各タスクで SVID の入れ替えを 13 回以上挟んで、失敗 0 件だった
**結論:** 段 B の配置で、プローブの bff の役が、連鎖を 1 秒の間隔で 30 分呼び続けた（B-3）。6 つのタスクのどれも、SVID が 13 回以上入れ替わり、失敗は 0 件だった。呼び出しは、Service Connect を通って、2 つの AZ のタスクに振り分けられた。

<details>
<summary>根拠</summary>

- コマンド: `aws/run-scenarios.sh soak 30`（2026-11-17 23:57〜2026-11-18 0:28 JST）
- 結果: `成功 1403 回、失敗 0 件。入れ替え bff 13 回（2 タスクの最少）、transfer 13 回（2 タスクの最少）、ledger 13 回（2 タスクの最少）`。3 分ごとの集計でも、失敗は一度も出なかった。

</details>

### 7-6. SPIRE server を別の AZ へ移すと、server は 24 秒いなかったが、連鎖の失敗は 0 件で、CA も変わらなかった
第 2 部の [findings 3-5](../findings.md#3-5-spire-server-を別の-az-へ移すとserver-は-24-秒いなかったが連鎖の失敗は-0-件でca-も変わらなかった) へ移した。

## 8. 未確認
- AZ がまるごと落ちたときと、server のタスクや台が突然消えたときに、server が何分で起き直すか（7-6）。移し先に台がなければ、台を起こすところから始まる。
- 0 台から起こすとき、マネージドスケーリングがなぜ 2 台と見積もるか（6-2）。
- IPv6 だけの台に、Session Manager で入れるか（5-4）。
- ECS 用の AMI のルートの容量が 30 GB で足りるか、小さくできるか。
