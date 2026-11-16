# 実機で確かめた事実

**この文書の読み手:** 実機で確かめた個別の事実を調べに来た開発者と AI エージェント。扱うのは、SPIRE の身元の配り方、mTLS の拒み方、SVID の入れ替え、Cognito の設定、AWS の段の作成。検証の計画と合格の基準は [plan.md](plan.md)、経過は [log.md](log.md)。用語は [用語集](glossary.md)。

各項目は、**結論**（見出しと数行）と、**根拠**（コマンド・出典・取得日）に分けて書く。1〜3 節はローカルの docker で 2026-11-15 に確かめた。環境は次のとおり。

| 部品 | 版 |
|---|---|
| OS | WSL2（Linux 6.18） |
| Docker | 29.1.3（cgroup v2） |
| SPIRE | 1.15.3 |
| spiffe-helper | 0.11.0 |
| Node.js | 24.21.0 |

5〜7 節は、AWS の東京リージョンで 2026-11-16〜17 に、AWS CLI 2.38.1 で確かめた。シナリオ 2（入れ替え）は、まだ AWS で回していない（[8 節](#8-未確認)）。

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
| 7-1 | AWS でも、シナリオは 10/10 件が期待どおりだった |
| 7-2 | 本物の委任のトークンは、`act` に `sub` と `client_id` の両方を持っていた |

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

## 5. AWS の段の作成
### 5-1. CloudFormation は、テンプレートの ASCII 以外の文字を「?」に置き換えた
**結論:** 日本語で書いたテンプレートの `Description`、パラメーターの `Description`、`Metadata` は、AWS の上では文字ごとに「?」になった。AWS CLI は UTF-8 のまま送っていた。JSON のテンプレートで日本語を `\u` のエスケープで書き、要求を ASCII だけにしても「?」が返ったので、置き換えは CloudFormation の側で起きている。YAML のコメントも、保存されたテンプレートの本文の中では同じく化ける。そのため、テンプレートの説明と Metadata は英語で書き、日本語の理由はリポジトリの `#` のコメントに置く。`scripts/check-templates.sh` が、コメント以外の行の ASCII 以外の文字を止める（`npm test` と `aws/deploy.sh` から呼ぶ）。

<details>
<summary>根拠</summary>

- コマンド: `aws cloudformation describe-stacks --query 'Stacks[0].Description'`、`aws cloudformation get-template`、`aws cloudformation validate-template --debug`
- 結果: `--debug` の要求の `TemplateBody` は日本語のまま、応答の XML は `<Description>??????</Description>` だった。`{"Description":"日本語", ...}` の検証は `"???"` を返した。
- 英語に直した registry、network、cognito のスタックは、変更セットがどれも Metadata の変更（置き換えなし）で、更新のあとは説明を読めた。

</details>

### 5-2. CloudFormation は、ExplicitAuthFlows の ALLOW_TOKEN_EXCHANGE_DELEGATION を受け付けた
**結論:** Cognito のスタックは作成に成功し、BFF と transfer の client の認証フローに `ALLOW_TOKEN_EXCHANGE_DELEGATION` が入った。4-1 で確かめていなかった、CloudFormation で設定が通るかの点は、これで決まった。交換が実際に動くかは、シナリオ 3-a で確かめる。

<details>
<summary>根拠</summary>

- コマンド: `aws cognito-idp describe-user-pool-client --query 'UserPoolClient.ExplicitAuthFlows'`（秘密を出さないように、この欄だけを読んだ）
- 結果: 2 つの client とも `ALLOW_REFRESH_TOKEN_AUTH` と `ALLOW_TOKEN_EXCHANGE_DELEGATION`。

</details>

### 5-3. ip6tables を書いた daemon.json で、ECS 用の AMI の docker が起動しなかった
**結論:** ユーザーデータで `/etc/docker/daemon.json` に `ipv6`、`fixed-cidr-v6`、`ip6tables` を書いて docker を再起動すると、docker が起動に失敗した。docker が動かないので ECS のエージェントも動かず、インスタンスはクラスターに登録されなかった。`"experimental": true` を足すと、docker は起動し、台は ECS に登録された。原因は、AMI の docker が 27 より前の版で、`ip6tables` に experimental が要るためと推定している（docker の journal は見ていない）。

<details>
<summary>根拠</summary>

- AMI: `/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id`（2026-11-16 の値）
- コマンド: `aws ec2 get-console-output --latest`
- 結果: `systemctl restart docker` の直後に `Job for docker.service failed`、`Failed to run module scripts-user`。ECS のクラスターのコンテナインスタンスは 0 件で、サービスは `No Container Instances were found` を出し続けた。同じ出力に、SSM Agent の `unable to acquire credentials` もあった。
- `"experimental": true` を足した版（コミット `ae821af`）では、2 台とも ECS に登録された。

</details>

### 5-4. 既定の AWS の名前は IPv4 だけで、デュアルスタックの名前に向けると、公開 IPv4 なしで動いた
**結論:** 東京リージョンの既定の名前（`ecs`、`logs`、`ec2`、`ssm` の `*.amazonaws.com`、イメージの取得先 `<アカウント>.dkr.ecr.*.amazonaws.com`）には、IPv6 のアドレスがなかった。デュアルスタックの名前（`*.api.aws`、`<アカウント>.dkr-ecr.*.on.aws`）には、あった。次のように向けると、公開 IPv4 も NAT もないまま動いた。動いたのは、台の登録、イメージの取得、ログの送信、Service Connect の Envoy、EFS、SPIRE server からの EC2 の API の呼び出し。
- **ECS のエージェント:** `/etc/ecs/ecs.config` に `AWS_USE_DUALSTACK_ENDPOINT=true` を書いた。
- **イメージ:** URI を `dkr-ecr.….on.aws` の形にした（`aws/deploy.sh`）。
- **docker の awslogs:** デーモンに、`AWS_USE_DUALSTACK_ENDPOINT` と `AWS_ENDPOINT_URL_CLOUDWATCH_LOGS` を渡した（5-5）。
- **SPIRE server:** `AWS_USE_DUALSTACK_ENDPOINT=true` を渡した。

Cognito（`cognito-idp` と、マネージドログインのドメイン）は、既定の名前に IPv6 のアドレスがあった。Session Manager で台に入れるかは、確かめていない。

<details>
<summary>根拠</summary>

- コマンド: `getent ahostsv6 <名前>`（2026-11-16）
- 結果: 上の既定の名前はどれも IPv6 なし。`ecs`、`ecr`、`ssm`、`ec2`、`logs`、`sts`、`servicediscovery`、`ecs-sc` の `*.ap-northeast-1.api.aws` と、`dkr-ecr.….on.aws` は IPv6 あり。`api.ecr`、`ec2messages`、`cognito-idp`、`elasticfilesystem` の `*.api.aws` は、名前がなかった。
- 動いた証拠: `aws ecs list-container-instances` が 2 台。各サービスのタスクのコンテナが 3 つ（app、svid-helper、Envoy）で RUNNING。CloudWatch Logs にアプリと SPIRE のログが届いた。

</details>

### 5-5. ECS は、タスク定義の awslogs-endpoint を受け付けなかった
**結論:** ログの送り先を変える `awslogs-endpoint` をタスク定義の `LogConfiguration` に書くと、`Log driver awslogs disallows options: awslogs-endpoint` でタスク定義を作れなかった。awslogs のドライバーは docker のデーモンの中で動くので、ユーザーデータで docker の systemd の設定に `AWS_ENDPOINT_URL_CLOUDWATCH_LOGS=https://logs.<リージョン>.api.aws` を渡すと、IPv6 だけの台からログが届いた。

<details>
<summary>根拠</summary>

- 結果: CloudFormation の `CREATE_FAILED` の理由（`ClientException`、2026-11-16）。直した版では、`/gekko13/ecs` のロググループに、各コンテナのログストリームができた。

</details>

### 5-6. 作成中に巻き戻すと、Cloud Map の名前空間がスタックの外に残った
**結論:** ECS のスタックの作成が、別の資源で失敗して巻き戻った。このとき CloudFormation は、作成中だった Cloud Map のプライベート DNS 名前空間を「取り消し」にした。ところが Cloud Map の側では作成が最後まで進み、名前空間と、対になるプライベートのホストゾーン（月額がかかる）が残った。次の作成は、同じ名前のホストゾーンとぶつかって失敗した（`ConflictingDomainExists`）。巻き戻したあとは、`aws servicediscovery list-namespaces` で取り残しを確かめる。

<details>
<summary>根拠</summary>

- 結果: 2 回目の作成で `The VPC … has already been associated with the hosted zone … with the same domain name`。`list-namespaces` に、1 回目の作成の時刻の `svc.gekko13.internal` があり、サービスは 0 件だった。`delete-namespace` で消すと、ホストゾーンも消えた。

</details>

### 5-7. CloudFormation は、YAML のエイリアスを受け付けなかった
**結論:** 同じ環境変数の並びを、YAML のアンカー（`&名前`）とエイリアス（`*名前`）で 3 つのタスク定義に使い回すと、`YAML aliases are not allowed in CloudFormation templates` で検証に通らなかった。同じ中身を書き出す。

<details>
<summary>根拠</summary>

- コマンド: `aws cloudformation validate-template --template-body file://aws/ecs.yaml`（2026-11-16）

</details>

### 5-8. AWS CLI 2.38.1 は、標準入力からの値の渡し方の一部で失敗し、--output text は末尾に改行を付けた
**結論:** 秘密を引数に載せずに渡すつもりで使った書き方の一部が、動かなかった。
- **`--cli-input-json file:///dev/stdin`:** パイプから渡すと、`Invalid JSON received` になった。`file:///dev/fd/0` と `-` も同じだった。
- **`--value file:///dev/stdin`:** Node.js の `execFileSync` の `input` で渡すと、`No such device or address: '/dev/stdin'` になった。シェルのパイプからなら読めた。
- **`--output text`:** 値の末尾に改行を付けた。client の秘密をそのまま SSM に入れると、Cognito が `400 invalid_client` を返した。

秘密は、改行を取り、メモリの上（`/dev/shm`）の、本人だけが読める一時ファイルから `file://` で渡し、すぐに消す（`aws/deploy.sh`、`aws/create-user.sh`、`scripts/aws-login.ts`）。

<details>
<summary>根拠</summary>

- コマンド: 秘密を含まない `aws ssm get-parameter --cli-input-json` と `put-parameter --value` で再現した（2026-11-16）。
- 結果: SSM の秘密の長さは 52 文字、Cognito の値は 51 文字だった。改行を取って入れ直すと、シナリオ 3-a が 200 を返した。

</details>

## 6. AWS の段のスケールと身元
6 節と 7 節は、コミット `ae821af` と `1bc38a8` の作りで確かめた。台は ECS のキャパシティプロバイダー（マネージドスケーリング、0〜2 台、t4g.small）が決める。アプリどうしは Service Connect で呼び、SPIRE server は awsvpc で動き、状態を EFS に置く。

### 6-1. agent の DAEMON だけが残った台を、マネージドスケーリングは空として縮めた
**結論:** サービスのタスクを 0 にすると、agent（DAEMON）が 2 台で動いたままでも、`CapacityProviderReservation` はすぐに 0 % になった。台数を決めるこの指標は、DAEMON のタスクを数えない。ECS のコンソールの「実行中のタスク」は DAEMON も数えるので、見え方が違う。縮小のアラームは「100 % 未満が 1 分ごとに 15 回」で働き、1 回に 1 台ずつ（`MaximumScalingStepSize: 1`）縮めたので、0 台まで約 18 分かかった。`aws/scale.sh down` は、タスクが 0 になったら ASG の希望台数を直接 0 にして、この待ちを省く。

<details>
<summary>根拠</summary>

- コマンド: `aws cloudwatch get-metric-statistics --namespace AWS/ECS/ManagedScaling --metric-name CapacityProviderReservation`、`aws cloudwatch describe-alarms`、`aws autoscaling describe-scaling-activities`（2026-11-16〜17）
- 結果: タスクを 0 にした直後から 0 %。`AlarmLow` は `LessThanThreshold 100`、`EvaluationPeriods 15`。2 台から 1 台、1 台から 0 台の縮小は、それぞれ 1 分の間を空けて動いた。

</details>

### 6-2. 0 台から起こすとき、マネージドスケーリングは 2 台を起こした
**結論:** 各サービスが 1 タスクで、1 台のメモリの約 2 割しか使わないのに、0 台から起こすと、2 回とも 2 台を起こした。作成の直後の `CapacityProviderReservation` は 200 % だった。なぜ 2 台と見積もるのかは、分かっていない。

<details>
<summary>根拠</summary>

- 結果: 台ごとの残りのメモリは 1,846 MiB のうち 1,526 MiB。`describe-scaling-activities` では、2 台を同時に起動した。

</details>

### 6-3. 台を 0 にして起こし直しても、EFS の上の SPIRE の CA と登録は残った
**結論:** SPIRE server のデータストア（sqlite）と鍵を EFS に置くと、台が 2 台とも入れ替わったあとも、server は同じ CA を読み込んだ。registrar（server のタスクの中で登録を作るコンテナ）は、4 つの登録をどれも作り直さなかった。

<details>
<summary>根拠</summary>

- 結果: 起き直した server のログに `Journal loaded … x509_cas=1` と `X509 CA activated`。`local_authority_id` と `issued_at` は、0 台にする前と同じだった。registrar は 4 件とも `exists` を出した。

</details>

### 6-4. aws_iid のノードの確認は、インスタンスのタグのセレクターで通った
**結論:** ASG が起こした台の agent は、どちらも aws_iid の確認を通った。登録のノードのセレクターは `aws_iid:tag:gekko13-role:ecs-host` の 1 つで、台がいくつでも足りた。agent は、Cloud Map の A レコードの名前（`spire-server.svc.gekko13.internal`）で、awsvpc の server に届いた。

<details>
<summary>根拠</summary>

- 結果: server のログに、2 台の agent の `Agent attestation request completed`。続けて、agent が bff、transfer、ledger の SVID を作った（`Creating X509-SVID`）。

</details>

### 6-5. server が 5 分ほどいないと、agent は自分の SVID が切れて止まった
**結論:** server を 0 にして台が残っている間、agent は server に届かず（`no children to pick from`）、5 分ほどで `current SVID has already expired` で止まり、ECS の起こし直しを繰り返した。agent の SVID の有効期限も、server の `default_x509_svid_ttl`（5 分）に従うためと推定している。ワークロードの SVID も 5 分なので、server が 1 つの今の作りでは、server が 5 分ほど止まると、どの台でも mTLS が続けられなくなる（推定）。台を起こし直すときも、agent が server より先に起き、server が起きるまでの約 1 分、止まっては起き直した。

<details>
<summary>根拠</summary>

- コマンド: `aws ecs list-tasks --desired-status STOPPED`、agent のログ（2026-11-16〜17）
- 結果: 止まった agent のタスクは 36 件。大半は server を 0 にしたあとで、起こし直しのときは 4 件（`could not open attestation stream`）。

</details>

## 7. AWS のシナリオ
### 7-1. AWS でも、シナリオは 10/10 件が期待どおりだった
**結論:** AWS で、1-a、1-b、3-a〜3-g が期待どおりになった。攻撃する側は、乗っ取られたタスクを演じるプローブで、本物のファミリーの別の版として動き、自分の svid-helper が得た SVID だけを使う。1-b は、登録していないファミリーの rogue のタスクで確かめた。1-c はホストのシェルが要るので対象外。サービスは 2 台に分かれて置かれ、BFF → transfer → ledger の連鎖は、台をまたいで Service Connect を通った。シナリオ 2（入れ替え）は、AWS ではまだ回していない。

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

## 8. 未確認
- シナリオ 2（入れ替え）を AWS で回すこと。`aws/run-scenarios.sh soak 30` で確かめる。
- 0 台から起こすとき、マネージドスケーリングがなぜ 2 台と見積もるか（6-2）。
- IPv6 だけの台に、Session Manager で入れるか（5-4）。
- ECS 用の AMI のルートの容量が 30 GB で足りるか、小さくできるか。
- 段 B: 2 つの AZ に複数のタスクを置いたときの動き。server が 1 つであることの影響（6-5）も含む。
