# 実機で確かめた事実

**この文書の読み手:** 実機で確かめた個別の事実を調べに来た開発者と AI エージェント。扱うのは、第 2 部の基盤（ECS on EC2、SPIRE、IPv6 だけの AWS）と、第 2 部で確かめたこと。検証の計画と合格の基準は [plan.md](plan.md)、経過は [log.md](log.md)、判断の理由は [design-decisions.md](design-decisions.md)。用語は [用語集](glossary.md)。

各項目は、**結論**（見出しと数行）と、**根拠**（コマンド・出典・取得日）に分けて書く。1〜3 節は、第 1 部（2026-11-15〜18）で確かめた基盤の事実で、第 2 部でも使い続ける。1 節の一部はローカルの docker で、ほかは AWS の東京リージョンで確かめた。第 2 部で確かめたことは、4 節から足す（4 節は段 C）。環境は次のとおり。

| 部品 | 版 |
|---|---|
| SPIRE | 1.15.3 |
| spiffe-helper | 0.11.0 |
| Node.js | 24 |
| Java、Spring Boot、Spring Authorization Server | 21（Eclipse Temurin）、3.5.16、1.5.8 |
| AWS CLI | 2.38.1 |
| ローカルの docker | 29.1.3（WSL2、cgroup v2） |
| AWS の台 | t4g.small、ECS 用の Amazon Linux 2023（arm64）の推奨の AMI |

## 一覧
| 項目 | 確かめた事実 |
|---|---|
| 1-1 | docker の attestor は、ECS と同じ名前のラベルで、ファミリーごとに別の SPIFFE ID を配った |
| 1-2 | 登録していないファミリーのコンテナには、SVID が出なかった |
| 1-3 | ラベルを偽ったコンテナにも SVID が出る |
| 1-4 | 有効期限 300 秒の SVID は、約 2.5 分ごとに入れ替わった |
| 1-5 | aws_iid のノードの確認は、インスタンスのタグのセレクターで通った |
| 2-1 | CloudFormation は、テンプレートの ASCII 以外の文字を「?」に置き換えた |
| 2-2 | ip6tables を書いた daemon.json で、ECS 用の AMI の docker が起動しなかった |
| 2-3 | 既定の AWS の名前は IPv4 だけで、デュアルスタックの名前に向けると、公開 IPv4 なしで動いた |
| 2-4 | ECS は、タスク定義の awslogs-endpoint を受け付けなかった |
| 2-5 | 作成中に巻き戻すと、Cloud Map の名前空間がスタックの外に残った |
| 2-6 | CloudFormation は、YAML のエイリアスを受け付けなかった |
| 2-7 | AWS CLI 2.38.1 は、標準入力からの値の渡し方の一部で失敗し、--output text は末尾に改行を付けた |
| 2-8 | RUN のない Dockerfile なら、エミュレーションなしで arm64 のイメージを作れた |
| 2-9 | CloudFormation は、テンプレートに書いていない項目を、外から変えても戻さなかった |
| 2-10 | CloudFormation が更新しているサービスに新しいデプロイを強制すると、スタックの更新が失敗して巻き戻った |
| 2-11 | IPv6 だけの台は、Session Manager に登録されなかった |
| 3-1 | agent の DAEMON だけが残った台を、マネージドスケーリングは空として縮めた |
| 3-2 | 0 台から起こすとき、マネージドスケーリングは 2 台を起こした |
| 3-3 | 台を 0 にして起こし直しても、EFS の上の SPIRE の CA と登録は残った |
| 3-4 | server が 5 分ほどいないと、agent は自分の SVID が切れて止まった |
| 3-5 | SPIRE server を別の AZ へ移すと、server は 24 秒いなかったが、連鎖の失敗は 0 件で、CA も変わらなかった |
| 3-6 | SPIRE server を冗長にするには、全部の server が 1 つの SQL のデータストアを共有する。DynamoDB は使えない |
| 3-7 | Aurora Serverless v2 は 0 ACU まで縮み、つながりが 1 本でもあると止まらない |
| 4-1 | CloudFront は、送り先の IP の種類を ipv6 にすると、IPv6 だけの台に届いた。既定の ipv4 では届かなかった |
| 4-2 | 台が入れ替わると、送り先を向け直すまで届かず、向け直してから約 100 秒で届いた |
| 4-3 | ある台で、IPv6 で公開したポートが、ある時間だけ拒まれた。原因は分からない |
| 4-4 | Spring Authorization Server は、Envoy なしで SVID の mTLS を自分で終え、交換したトークンを呼び手の SVID の証明書に結んだ |
| 4-5 | Spring Authorization Server の交換は、元のトークンの保存に利用者がないと、説明なしの invalid_grant で拒んだ |
| 4-6 | SVID が入れ替わると、前の証明書に結んだトークンは、交換の actor_token に使えなくなった |
| 4-7 | SPIRE は、SVID を入れ替えるたびに、鍵の組も新しく作った |
| 4-8 | CloudFront は、プライベートのサブネットの台に VPC origin で届き、パスで 2 つの受け口に振り分けた。台から見た送り主は、CloudFront の公開 IPv4 だった |
| 4-9 | CloudFront は、配信が使っている VPC origin の更新を拒んだ。VPC origin を 2 組持って切り替えると、向け直しは 3〜6 分だった |
| 4-10 | 配信の既定のドメインを RP ID にして、パスキーを登録し、別のパスの受け口で文書のハッシュに署名できた。cloudfront.net は RP ID にできなかった |
| 4-11 | t4g.medium 1 台に Keycloak と認可サーバーが載り、台が 0 の状態から約 6〜7 分で使えた。いちばん長いのは VPC origin の向け直しだった |
| 4-12 | 日本語のコメントを含めた ECS のテンプレートは、直接送れる大きさ（51,200 バイト）を超えた |
| 4-13 | spiffe-helper は root で動き、鍵を 0600 で書いたので、root でない利用者のアプリは鍵を読めなかった |
| 4-14 | ECS のスタックの更新が止まる前に起きた台は、古い起動テンプレートのまま残った |
| 4-15 | 入口を内部向けの ALB にすると、台が 0 の状態から約 3 分で使え、2 つの AZ のどちらの台にも届いた |
| 4-16 | ALB を指す VPC origin を作るのに約 9 分、配信の切り替えに約 1 分、古い VPC origin を消すのに約 7 分かかった |
| 4-17 | 入口の中継（Web Functions）は、NetworkConnector の先から名前空間の SRV を引き、2 つの AZ のタスクに届いた。本文付きの POST と複数の Set-Cookie が通り、エンドポイントを直接呼ぶと 403 だった |
| 4-18 | NetworkConnector の操作ロールと Web Functions の実行ロールは、信頼ポリシーに aws:SourceAccount の条件があると、Lambda に引き受けられなかった |
| 4-19 | CloudFront は、Web Functions の送り先の OAC に、署名の仕方 always を拒み、always-amz-auth を求めた |
| 4-20 | NetworkConnector を作るのに約 4 分、中継のリビジョンとエンドポイントは十数秒、配信の切り替えに約 3 分かかった |
| 4-21 | 入口を Web Functions の中継にしても、台が 0 の状態から約 3〜4 分で使え、2 つの AZ のどちらの台にも届いた。台が 0 の間、配信は 503 を返した |
| 4-22 | 名前空間の DNS は、全部のタスクが UNHEALTHY のとき、UNHEALTHY のタスクも返した |
| 4-23 | 台を全部スポットにしても、2 つの AZ に台が起き、台が 0 の状態から約 3 分半で使えた。1a では t4g.large が選ばれた |

## 1. 身元の配り方
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

### 1-5. aws_iid のノードの確認は、インスタンスのタグのセレクターで通った
**結論:** ASG が起こした台の agent は、どちらも aws_iid の確認を通った。登録のノードのセレクターは `aws_iid:tag:gekko13-role:ecs-host` の 1 つで、台がいくつでも足りた。agent は、Cloud Map の A レコードの名前（`spire-server.svc.gekko13.internal`）で、awsvpc の server に届いた。

<details>
<summary>根拠</summary>

- 結果: server のログに、2 台の agent の `Agent attestation request completed`。続けて、agent が bff、transfer、ledger の SVID を作った（`Creating X509-SVID`）。

</details>

## 2. AWS で作るときに当たること
### 2-1. CloudFormation は、テンプレートの ASCII 以外の文字を「?」に置き換えた
**結論:** 日本語で書いたテンプレートの `Description`、パラメーターの `Description`、`Metadata` は、AWS の上では文字ごとに「?」になった。AWS CLI は UTF-8 のまま送っていた。JSON のテンプレートで日本語を `\u` のエスケープで書き、要求を ASCII だけにしても「?」が返ったので、置き換えは CloudFormation の側で起きている。YAML のコメントも、保存されたテンプレートの本文の中では同じく化ける。そのため、テンプレートの説明と Metadata は英語で書き、日本語の理由はリポジトリの `#` のコメントに置く。`scripts/check-templates.sh` が、コメント以外の行の ASCII 以外の文字を止める（`npm test` と `aws/deploy.sh` から呼ぶ）。

<details>
<summary>根拠</summary>

- コマンド: `aws cloudformation describe-stacks --query 'Stacks[0].Description'`、`aws cloudformation get-template`、`aws cloudformation validate-template --debug`
- 結果: `--debug` の要求の `TemplateBody` は日本語のまま、応答の XML は `<Description>??????</Description>` だった。`{"Description":"日本語", ...}` の検証は `"???"` を返した。
- 英語に直した registry、network、cognito のスタックは、変更セットがどれも Metadata の変更（置き換えなし）で、更新のあとは説明を読めた。

</details>

### 2-2. ip6tables を書いた daemon.json で、ECS 用の AMI の docker が起動しなかった
**結論:** ユーザーデータで `/etc/docker/daemon.json` に `ipv6`、`fixed-cidr-v6`、`ip6tables` を書いて docker を再起動すると、docker が起動に失敗した。docker が動かないので ECS のエージェントも動かず、インスタンスはクラスターに登録されなかった。`"experimental": true` を足すと、docker は起動し、台は ECS に登録された。原因は、AMI の docker が 27 より前の版で、`ip6tables` に experimental が要るためと推定している（docker の journal は見ていない）。

<details>
<summary>根拠</summary>

- AMI: `/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id`（2026-11-16 の値）
- コマンド: `aws ec2 get-console-output --latest`
- 結果: `systemctl restart docker` の直後に `Job for docker.service failed`、`Failed to run module scripts-user`。ECS のクラスターのコンテナインスタンスは 0 件で、サービスは `No Container Instances were found` を出し続けた。同じ出力に、SSM Agent の `unable to acquire credentials` もあった。
- `"experimental": true` を足した版（コミット `ae821af`）では、2 台とも ECS に登録された。

</details>

### 2-3. 既定の AWS の名前は IPv4 だけで、デュアルスタックの名前に向けると、公開 IPv4 なしで動いた
**結論:** 東京リージョンの既定の名前（`ecs`、`logs`、`ec2`、`ssm` の `*.amazonaws.com`、イメージの取得先 `<アカウント>.dkr.ecr.*.amazonaws.com`）には、IPv6 のアドレスがなかった。デュアルスタックの名前（`*.api.aws`、`<アカウント>.dkr-ecr.*.on.aws`）には、あった。次のように向けると、公開 IPv4 も NAT もないまま動いた。動いたのは、台の登録、イメージの取得、ログの送信、Service Connect の Envoy、EFS、SPIRE server からの EC2 の API の呼び出し。
- **ECS のエージェント:** `/etc/ecs/ecs.config` に `AWS_USE_DUALSTACK_ENDPOINT=true` を書いた。
- **イメージ:** URI を `dkr-ecr.….on.aws` の形にした（`aws/deploy.sh`）。
- **docker の awslogs:** デーモンに、`AWS_USE_DUALSTACK_ENDPOINT` と `AWS_ENDPOINT_URL_CLOUDWATCH_LOGS` を渡した（2-4）。
- **SPIRE server:** `AWS_USE_DUALSTACK_ENDPOINT=true` を渡した。

Cognito（`cognito-idp` と、マネージドログインのドメイン）は、既定の名前に IPv6 のアドレスがあった。Session Manager には登録されなかった（2-11）。

<details>
<summary>根拠</summary>

- コマンド: `getent ahostsv6 <名前>`（2026-11-16）
- 結果: 上の既定の名前はどれも IPv6 なし。`ecs`、`ecr`、`ssm`、`ec2`、`logs`、`sts`、`servicediscovery`、`ecs-sc` の `*.ap-northeast-1.api.aws` と、`dkr-ecr.….on.aws` は IPv6 あり。`api.ecr`、`ec2messages`、`cognito-idp`、`elasticfilesystem` の `*.api.aws` は、名前がなかった。
- 動いた証拠: `aws ecs list-container-instances` が 2 台。各サービスのタスクのコンテナが 3 つ（app、svid-helper、Envoy）で RUNNING。CloudWatch Logs にアプリと SPIRE のログが届いた。

</details>

### 2-4. ECS は、タスク定義の awslogs-endpoint を受け付けなかった
**結論:** ログの送り先を変える `awslogs-endpoint` をタスク定義の `LogConfiguration` に書くと、`Log driver awslogs disallows options: awslogs-endpoint` でタスク定義を作れなかった。awslogs のドライバーは docker のデーモンの中で動くので、ユーザーデータで docker の systemd の設定に `AWS_ENDPOINT_URL_CLOUDWATCH_LOGS=https://logs.<リージョン>.api.aws` を渡すと、IPv6 だけの台からログが届いた。

<details>
<summary>根拠</summary>

- 結果: CloudFormation の `CREATE_FAILED` の理由（`ClientException`、2026-11-16）。直した版では、`/gekko13/ecs` のロググループに、各コンテナのログストリームができた。

</details>

### 2-5. 作成中に巻き戻すと、Cloud Map の名前空間がスタックの外に残った
**結論:** ECS のスタックの作成が、別の資源で失敗して巻き戻った。このとき CloudFormation は、作成中だった Cloud Map のプライベート DNS 名前空間を「取り消し」にした。ところが Cloud Map の側では作成が最後まで進み、名前空間と、対になるプライベートのホストゾーン（月額がかかる）が残った。次の作成は、同じ名前のホストゾーンとぶつかって失敗した（`ConflictingDomainExists`）。巻き戻したあとは、`aws servicediscovery list-namespaces` で取り残しを確かめる。

<details>
<summary>根拠</summary>

- 結果: 2 回目の作成で `The VPC … has already been associated with the hosted zone … with the same domain name`。`list-namespaces` に、1 回目の作成の時刻の `svc.gekko13.internal` があり、サービスは 0 件だった。`delete-namespace` で消すと、ホストゾーンも消えた。

</details>

### 2-6. CloudFormation は、YAML のエイリアスを受け付けなかった
**結論:** 同じ環境変数の並びを、YAML のアンカー（`&名前`）とエイリアス（`*名前`）で 3 つのタスク定義に使い回すと、`YAML aliases are not allowed in CloudFormation templates` で検証に通らなかった。同じ中身を書き出す。

<details>
<summary>根拠</summary>

- コマンド: `aws cloudformation validate-template --template-body file://aws/ecs.yaml`（2026-11-16）

</details>

### 2-7. AWS CLI 2.38.1 は、標準入力からの値の渡し方の一部で失敗し、--output text は末尾に改行を付けた
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

### 2-8. RUN のない Dockerfile なら、エミュレーションなしで arm64 のイメージを作れた
**結論:** この環境の buildx には arm64 のエミュレーション（QEMU）がない。依存（`jose`。純粋な JavaScript）をホストで入れて写し、Dockerfile から `RUN` をなくすと、`--platform linux/arm64` のイメージを作れた。

<details>
<summary>根拠</summary>

- コマンド: `docker buildx build --platform linux/arm64 -f Dockerfile <scripts/stage-image.sh の出力>`
- 結果: イメージができた。`docker buildx ls` の対応は `linux/amd64 (+3)` で、arm64 の実行は含まない。

</details>

### 2-9. CloudFormation は、テンプレートに書いていない項目を、外から変えても戻さなかった
**結論:** 入れ替えの試験（3-5）で、spire-server のサービスに「今の AZ 以外に置く」置き方の制約を外から付けた。そのあと 1 つの AZ の作りに戻してスタックを更新しても、テンプレートに制約の項目を書いていないので、CloudFormation は制約を残したままにした。制約に合う台がないので、server のタスクは置き場を待ち続け（`PROVISIONING`）、スタックの更新もサービスの安定を待ち続けた。外から変える項目は、変えた手順の側で元に戻す。`aws/run-scenarios.sh` は、server を移し終えたらすぐに制約を外し、`aws/deploy.sh` は、更新の前に制約が残っていれば外す。

<details>
<summary>根拠</summary>

- コマンド: `aws ecs describe-services --services spire-server --query 'services[0].placementConstraints'`（2026-11-18）
- 結果: `memberOf`、`attribute:ecs.availability-zone != ap-northeast-1a` が残っていた。台は 2 台とも ap-northeast-1a で、メモリと ENI には空きがあった。

</details>

### 2-10. CloudFormation が更新しているサービスに新しいデプロイを強制すると、スタックの更新が失敗して巻き戻った
**結論:** CloudFormation が spire-server のサービスを更新している最中に、`aws ecs update-service --force-new-deployment` で新しいデプロイを強制した。CloudFormation は、自分が始めたデプロイが置き換えられたとみなし、サービスの更新を失敗にして、スタック全体を巻き戻した。スタックの更新の最中は、そのスタックのサービスに手を出さない。

<details>
<summary>根拠</summary>

- 結果: `SpireServerService UPDATE_FAILED Error occurred during operation 'Replaced by a new service deployment.'`、続けて `UPDATE_ROLLBACK_COMPLETE`（2026-11-18）。巻き戻しのあと、同じ更新を回し直すと通った。

</details>

### 2-11. IPv6 だけの台は、Session Manager に登録されなかった
**結論:** IPv6 だけの台の SSM Agent は、インスタンスプロファイルの認証情報を取れず、Systems Manager に登録されなかった。Session Manager で台に入ることはできない。台の中を見る必要があるときは、作業の間だけ公開 IPv4 を付けるなどの手が要る（未確認）。

<details>
<summary>根拠</summary>

- コマンド: `aws ssm describe-instance-information`（2026-11-18）
- 結果: 登録された台は 0 台。台のコンソールの出力に、`SSM Agent unable to acquire credentials` が出ていた。

</details>

## 3. スケールと SPIRE server
### 3-1. agent の DAEMON だけが残った台を、マネージドスケーリングは空として縮めた
**結論:** サービスのタスクを 0 にすると、agent（DAEMON）が 2 台で動いたままでも、`CapacityProviderReservation` はすぐに 0 % になった。台数を決めるこの指標は、DAEMON のタスクを数えない。ECS のコンソールの「実行中のタスク」は DAEMON も数えるので、見え方が違う。縮小のアラームは「100 % 未満が 1 分ごとに 15 回」で働き、1 回に 1 台ずつ（`MaximumScalingStepSize: 1`）縮めたので、0 台まで約 18 分かかった。`aws/scale.sh down` は、タスクが 0 になったら ASG の希望台数を直接 0 にして、この待ちを省く。

<details>
<summary>根拠</summary>

- コマンド: `aws cloudwatch get-metric-statistics --namespace AWS/ECS/ManagedScaling --metric-name CapacityProviderReservation`、`aws cloudwatch describe-alarms`、`aws autoscaling describe-scaling-activities`（2026-11-16〜17）
- 結果: タスクを 0 にした直後から 0 %。`AlarmLow` は `LessThanThreshold 100`、`EvaluationPeriods 15`。2 台から 1 台、1 台から 0 台の縮小は、それぞれ 1 分の間を空けて動いた。

</details>

### 3-2. 0 台から起こすとき、マネージドスケーリングは 2 台を起こした
**結論:** 各サービスが 1 タスクで、1 台のメモリの約 2 割しか使わないのに、0 台から起こすと、2 回とも 2 台を起こした。作成の直後の `CapacityProviderReservation` は 200 % だった。なぜ 2 台と見積もるのかは、分かっていない。

<details>
<summary>根拠</summary>

- 結果: 台ごとの残りのメモリは 1,846 MiB のうち 1,526 MiB。`describe-scaling-activities` では、2 台を同時に起動した。

</details>

### 3-3. 台を 0 にして起こし直しても、EFS の上の SPIRE の CA と登録は残った
**結論:** SPIRE server のデータストア（sqlite）と鍵を EFS に置くと、台が 2 台とも入れ替わったあとも、server は同じ CA を読み込んだ。registrar（server のタスクの中で登録を作るコンテナ）は、4 つの登録をどれも作り直さなかった。

<details>
<summary>根拠</summary>

- 結果: 起き直した server のログに `Journal loaded … x509_cas=1` と `X509 CA activated`。`local_authority_id` と `issued_at` は、0 台にする前と同じだった。registrar は 4 件とも `exists` を出した。

</details>

### 3-4. server が 5 分ほどいないと、agent は自分の SVID が切れて止まった
**結論:** server を 0 にして台が残っている間、agent は server に届かず（`no children to pick from`）、5 分ほどで `current SVID has already expired` で止まり、ECS の起こし直しを繰り返した。agent の SVID の有効期限も、server の `default_x509_svid_ttl`（5 分）に従う。`agent_ttl` を指定しなければ、この値になると資料にある（3-6）。ワークロードの SVID も 5 分なので、server が 1 つの今の作りでは、server が 5 分ほど止まると、どの台でも mTLS が続けられなくなる（推定）。台を起こし直すときも、agent が server より先に起き、server が起きるまでの約 1 分、止まっては起き直した。

<details>
<summary>根拠</summary>

- コマンド: `aws ecs list-tasks --desired-status STOPPED`、agent のログ（2026-11-16〜17）
- 結果: 止まった agent のタスクは 36 件。大半は server を 0 にしたあとで、起こし直しのときは 4 件（`could not open attestation stream`）。

</details>

### 3-5. SPIRE server を別の AZ へ移すと、server は 24 秒いなかったが、連鎖の失敗は 0 件で、CA も変わらなかった
**結論:** 連鎖を呼び続けながら、server を ap-northeast-1a から ap-northeast-1c へ移した（B-4）。移し方は、spire-server のサービスに「今の AZ 以外に置く」制約を付けて、新しいデプロイを強制した。古いタスクが止まり終わってから、新しい server が応答する（registrar の `server is healthy`）まで約 24 秒で、入れ替えを求めてからは約 101 秒だった。新しい server は EFS から同じ CA と 4 件の登録を読み、agent は 1 つも止まらず、連鎖の失敗は 0 件だった。server が戻ったあと、6 つのタスクの SVID は、新しい server の下で入れ替わった。

確かめたのは、計画して止めた入れ替えで、移し先の AZ に台がすでにあった場合に限る。AZ がまるごと落ちて台を起こすところから始まる場合と、server のタスクや台が突然消える場合は、確かめていない。CA の識別子は、前日の段 A のとき（`f29bcd7d…`）とは違っていた。`ca_ttl` が 24 時間なので、その間に SPIRE が CA を入れ替えたと推定している。

<details>
<summary>根拠</summary>

- コマンド: `FAILOVER_AFTER=3 aws/run-scenarios.sh failover 12`（2026-11-18 0:33〜0:47 JST）
- 結果: 古いタスクは 0:39:40 に止まり終わり、registrar は 0:40:04 に `server is healthy`、続けて 4 件とも `exists`。ECS は新しいタスクの開始を 0:40:21 と記録した。`X509 CA activated` の `local_authority_id` は、新旧とも `41ca2056…`。止まった agent は 0 個。`成功 561 回、失敗 0 件`。
- 試験の長さは、移す前 3 分、全体 12 分にした（plan.md の B-4 に長さの決まりはない。経緯は log.md）。

</details>

### 3-6. SPIRE server を冗長にするには、全部の server が 1 つの SQL のデータストアを共有する。DynamoDB は使えない
**結論:** SPIRE の資料によると、server を冗長にするには、同じ信頼ドメインの全部の server が、同じ 1 つのデータストアを読み書きする。データストアは組み込みの SQL のプラグインだけで、SQLite、PostgreSQL、MySQL に対応する。差し替える仕組みはもうないので、DynamoDB は使えない。SQLite は、複数の台で共有しにくく、本番には一般に勧めないとある。冗長の構成では、server ごとに自分の CA を持つ。`agent_ttl` の既定は `default_x509_svid_ttl` で、その既定は 1 時間。

この資料に、EFS や NFS の上の SQLite についての記述はない。データストアが 1 つなら、server を複数にしても、データストアが止まれば全体が止まる。可用性が上がるのは、server の側（タスク、台、AZ、更新）が落ちる場合だけになる（推定）。

<details>
<summary>根拠</summary>

- 出典: [Scaling SPIRE](https://spiffe.io/docs/latest/planning/scaling_spire/)、[Configuring SPIRE](https://spiffe.io/docs/latest/deploying/configuring/)、[SPIRE Server の資料](https://github.com/spiffe/spire/blob/main/doc/spire_server.md)（取得日 2026-11-17）
- 結果: 「Pluggability for the DataStore is no longer supported. Only the built-in SQL plugin can be used.」「each server maintains its own Certificate Authority」。`agent_ttl` の既定は「The value of `default_x509_svid_ttl`」。

</details>

### 3-7. Aurora Serverless v2 は 0 ACU まで縮み、つながりが 1 本でもあると止まらない
**結論:** Aurora Serverless v2 は、最小の容量を 0 ACU にすると、つながりがなくなってから 5 分〜1 日で自動で一時停止する。止まっている間のインスタンスの料金は 0 で、保存とクラスターの費用は残る。再開はふつう約 15 秒で、24 時間を超えて止まると 30 秒以上かかることがある。利用者のつながりが 1 本でも開いていると、止まらない。SPIRE server はつながりを持ち続けるので、止まるのは server を 0 にしたあとだけになる（推定）。ライターは 1 つなので、データベースまで AZ の障害に耐えさせるには、別の AZ にリーダーが要る。

<details>
<summary>根拠</summary>

- 出典: [Aurora Serverless v2 の自動の一時停止](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)（取得日 2026-11-17）。対応する版は、Aurora PostgreSQL 16.3、15.7、14.12、13.15 以上、Aurora MySQL 3.08.0 以上。
- 単価（料金の API、東京、2026-11-17）: Aurora PostgreSQL Serverless v2 は 1 ACU 1 時間 0.15 ドル、保存は 1 GB あたり月 0.12 ドル（どちらも標準）。

</details>

## 4. 段 C
### 4-1. CloudFront は、送り先の IP の種類を ipv6 にすると、IPv6 だけの台に届いた。既定の ipv4 では届かなかった
**結論:** 台の公開 IPv6 のアドレスを、AAAA だけを返す名前（sslip.io）にして、CloudFront のカスタムの送り先にした。送り先の IP の種類（`CustomOriginConfig` の `IpAddressType`）が既定の `ipv4` のままでは、CloudFront は 502「送り先の名前を解決できなかった」を返した。`ipv6` にすると、台の上のサービスに届いた。台から見た送り主は、CloudFront の IPv6 のアドレス（`2600:9000:` で始まる）だった。CloudFront は 2025 年 9 月から IPv6 だけの送り先に対応している。持ち主の指摘で分かり、この検証の最初の調べでは見落とした。

<details>
<summary>根拠</summary>

- 出典: [Amazon CloudFront now supports IPv6 origins](https://aws.amazon.com/about-aws/whats-new/2025/09/amazon-cloudfront-ipv6-origins/)（持ち主が示した。2025-09）
- コマンド: `aws/edge-point.sh`、`curl https://<配信の名前>/`（2026-11-18）
- 結果: `ipv4` のときは `502 … CloudFront wasn't able to resolve the origin domain name.`。`ipv6` のときは、確認用のサービスの JSON（`via_cloudfront: true`）。CloudFormation の型では、`IpAddressType` は `ipv4`、`ipv6`、`dualstack` から選ぶ。

</details>

### 4-2. 台が入れ替わると、送り先を向け直すまで届かず、向け直してから約 100 秒で届いた
**結論:** 台を 0 にして起こし直すと、CloudFront の送り先は古い台の名前のままなので、届かなかった（15 秒待っても応答が返らず、のちに 504）。`aws/edge-point.sh` で送り先を新しい台の名前に書き換えると、書き換えを求めてから約 100 秒で届いた。ほぼすべてが、CloudFormation による配信の更新の時間で、更新が終わってからは 1 秒で届いた。

<details>
<summary>根拠</summary>

- コマンド: `aws/scale.sh down`、`aws/scale.sh up`、`aws/edge-point.sh`（2026-11-18 22:09〜22:33）
- 結果: 書き換えから届くまで、98 秒（1 回目）と 99 秒（台を入れ替えたあと）。どちらも、スタックの更新が 97〜98 秒、そのあと 1 秒。

</details>

### 4-3. ある台で、IPv6 で公開したポートが、ある時間だけ拒まれた。原因は分からない
**結論:** 台を入れ替えたあと、確認用のサービスが置かれた台の IPv6 のアドレスの 8080 は、VPC の中の別の台からつないでも拒まれた（`ECONNREFUSED`）。同じ台に新しくタスクを起こしても、拒まれた。もう 1 台の台では届いた。2 台の起動の記録に違いはなかった。拒まれた台から SPIRE server（awsvpc）が出ていったあとは、届くようになった。ところが、server がいる別の台で新しくタスクを起こしても、再現しなかった。台の中に入れない（2-11）ので、原因は絞り込めていない。入口のタスクを CloudFront に向けるときは、実際に届くかを確かめてから終える必要がある。

<details>
<summary>根拠</summary>

- 試し方: 拒まれた台を指定して確認用のタスクを起こし、別の台から、登録していないファミリーのタスク（rogue）の確認役で `fetch("http://[<IPv6>]:8080/")` を送った（2026-11-18 22:24〜22:39）。
- 結果: 拒まれた台では、server がいる間に 2 回とも `ECONNREFUSED`。server が出ていったあとは届いた。server がいる別の台では、server が来る前に起きたタスクも、来たあとに起きたタスクも届いた。

</details>

### 4-4. Spring Authorization Server は、Envoy なしで SVID の mTLS を自分で終え、交換したトークンを呼び手の SVID の証明書に結んだ
**結論:** 認可サーバー（`services/auth`）は、spiffe-helper が書いた PEM を Spring Boot の SSL バンドルで読み、Tomcat で mTLS を終えた。C-4 の判定の 7 件（C4-1〜C4-7）は、すべて合格した。

- 証明書を示さない呼び手と、別の SVID で名乗った呼び手は、`401 invalid_client` で拒まれた。SPIRE 以外の CA の証明書は、TLS の握手で拒まれた。
- bff の SVID で得たトークンと、交換で得たトークンには、bff の証明書の拇印の `cnf.x5t#S256` が入った。交換で得たトークンには、`act.sub`（`bff-client`）も入った。
- bff のトークンを盗んだ transfer が交換を求めると、自分の SVID で正しく認証しても、`invalid_grant` で拒まれた。
- SVID が入れ替わると、認可サーバーは再起動なしで新しい証明書を示した。新しい SVID で得たトークンは、新しい拇印に結ばれた。

`act.sub` は SPIFFE ID ではなく、窓口の client_id になる。SPIFFE ID は、窓口の登録で client_id に結ぶ。起動の時間とメモリは、C-3 の見当にする。ローカルの x86 の機械では、Spring の起動が 5〜7 秒、メモリは約 240 MB（上限 512 MB）、イメージは約 510 MB だった。

<details>
<summary>根拠</summary>

- コマンド: `SVID_TTL=120 local/up.sh`、`node scripts/c4-check.ts`（2026-11-19）
- 結果: `7/7 合格`。C4-4 は `SSL alert number 46`（certificate unknown）。C4-6 は `subject_token does not allow the requester to act`。C4-7 は、auth の SVID のシリアルが変わったあと、示す証明書のシリアルが新しいファイルと一致した。読み直しは、Tomcat のログ `certificate … configured from keystore`（`ssl-bundle-watcher` のスレッド）で分かる。
- 起動の時間は `Started AuthApplication in 5.116 seconds` と `7.175 seconds`。メモリは `docker stats` で 236 MiB。
- Tomcat は起動のとき、「JSSE の TLS 1.3 は、握手のあとの認証（PHA）に対応しないので、任意のクライアント証明書（`client-auth: want`）と両立しない」と警告した。証明書は最初の握手で求めるので、判定には影響しなかった。

</details>

### 4-5. Spring Authorization Server の交換は、元のトークンの保存に利用者がないと、説明なしの invalid_grant で拒んだ
**結論:** client_credentials で出したトークンを、交換の元（subject_token）にすると、標準の交換の部品は、説明のない `invalid_grant` を返した。部品は、元のトークンの保存に利用者（`java.security.Principal` の属性）があることを求める。client_credentials の保存には、その属性が入らない。C-4 では、仮の窓口（user-standin）のトークンに限り、交換の前にこの属性を足した（`StandinSubjectPrincipal`）。段 D では、ログインサーバーのトークンを取り込むときに入れる。gekko_11 の認可サーバーも、取り込むときにこの属性を入れていた。

<details>
<summary>根拠</summary>

- コマンド: `node scripts/c4-check.ts` の C4-5（2026-11-19）。`javap -c` で `OAuth2TokenExchangeAuthenticationProvider`（1.5.8）を読んだ。
- 結果: 属性を足す前は `400 {"error":"invalid_grant"}`。部品は、`OAuth2Authorization.getAttribute(Principal)` が空なら、`invalid_grant` を投げていた。足したあとは 200。

</details>

### 4-6. SVID が入れ替わると、前の証明書に結んだトークンは、交換の actor_token に使えなくなった
**結論:** bff の SVID が入れ替わったあと、入れ替わる前に得た bff のトークンを actor_token にして、新しい SVID で交換を求めると、`actor_token is not bound to the requester certificate` で拒まれた。actor_token は、いま示す証明書に結ばれていることを確かめる作りなので、意図どおりである。段 D の呼び手は、SVID が入れ替わったら、自分のトークンを取り直す必要がある。

<details>
<summary>根拠</summary>

- コマンド: `node scripts/c4-check.ts` の C4-7 の参考の行（2026-11-19、`SVID_TTL=120`）
- 結果: `400 {"error_description":"actor_token is not bound to the requester certificate","error":"invalid_grant"}`

</details>

### 4-7. SPIRE は、SVID を入れ替えるたびに、鍵の組も新しく作った
**結論:** bff の SVID が 3 回入れ替わる間、証明書の公開鍵を比べると、3 回とも前と違った。秘密鍵のファイルの公開鍵も、毎回証明書と一致した。証明書だけでなく鍵も替わるので、トークンを証明書（`x5t#S256`）ではなく公開鍵（DPoP の `jkt` など）に結んでも、入れ替わりのあとは使えない。SVID に結んだトークンは、入れ替わるたびに取り直す必要がある（4-6）。

<details>
<summary>根拠</summary>

- コマンド: `openssl x509 -noout -pubkey` と `openssl pkey -pubout` の SHA-256 を、`local/run/svid/bff/` のシリアルが変わるたびに比べた（2026-11-19、ローカル、`SVID_TTL=120`）。
- 結果: 入れ替わりは約 55 秒ごとに 3 回。公開鍵の SHA-256 は 4 つとも違い、毎回 `svid.pem` と `svid_key.pem` の公開鍵は一致した。鍵は EC の P-256。

</details>

### 4-8. CloudFront は、プライベートのサブネットの台に VPC origin で届き、パスで 2 つの受け口に振り分けた。台から見た送り主は、CloudFront の公開 IPv4 だった
**結論:** サブネットの経路表から、IGW への経路をなくした（IPv4 も IPv6 も）。外へは、Egress-only のインターネットゲートウェイ（EIGW）から IPv6 で出る。台の受信は、同じグループと、CloudFront が VPC に作るグループ（`CloudFront-VPCOrigins-Service-SG`）からだけにした。この作りで、CloudFront は VPC origin を通して台の上のサービスに届いた。`/login/*` はログインサーバーの役の受け口（8081）に、ほかは顧客のアプリの役の受け口（8080）に届いた。プライベートにしたあとも、台は ECS に登録され、イメージを取れ、SPIRE の agent と全サービスが安定し、SVID の入れ替わりも続いた。

予測と違ったのは、台から見た送り主のアドレスである。VPC の中の IPv4 を予測したが、実際は CloudFront の公開 IPv4（`54.239.` で始まる）だった。CloudFront は、サブネットに自分が管理する ENI（プライベートの IPv4 と IPv6 を持ち、公開のアドレスは持たない）を 1 つ作っていた。この ENI を通るときに、送り主のアドレスを書き換えていないとみられる（推定）。台は公開 IPv4 を持たず、サブネットに IGW への経路がないので、インターネットから台に届く道はない（作りからの判断で、外から接続して試してはいない）。

<details>
<summary>根拠</summary>

- コマンド: `aws/deploy.sh`、`aws/scale.sh up`、`aws/edge-point.sh`、`aws ec2 describe-route-tables`、`describe-security-groups`、`describe-network-interfaces`（2026-11-19 23:23〜23:41）
- 結果: 経路表は、VPC の中の 2 つと `::/0 → eigw-…` だけ。IGW は VPC に付いたまま（VPC origin の条件）。ENI は `InterfaceType: cloudfront_managed`、`Description: CloudFront configured ENI`。応答は `"listener":"app"`（`/edge-point`）と `"listener":"login"`（`/login/edge-point`）、`"remote":"::ffff:54.239.215.205"`。
- 資料: [Restrict access with VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)（VPC に IGW が要る。東京は apne1-az3 を除く。この検証のサブネットは apne1-az4 と apne1-az1）、[Egress-only internet gateways](https://docs.aws.amazon.com/vpc/latest/userguide/egress-only-internet-gateway.html)（ゲートウェイの料金はない。外から始まる IPv6 の接続を通さない）。どちらも 2026-11-19 に読んだ。

</details>

### 4-9. CloudFront は、配信が使っている VPC origin の更新を拒んだ。VPC origin を 2 組持って切り替えると、向け直しは 3〜6 分だった
**結論:** 台を入れ替えたあと、VPC origin の送り先（インスタンスの ARN）を CloudFormation で書き換えた。CloudFront は 409 で拒み、スタックは巻き戻った。CloudFormation の型の説明は、この更新を「中断なし」としているが、当たらなかった。資料の手順（配信から外してから更新する）のほうが正しかった。そこで VPC origin を A と B の 2 組持ち、使っていない組を新しい台に向けてから、同じスタックの更新で配信を切り替える形にした。この形で 2 回向け直し、どちらも届いた。

| 回 | 中身 | 書き換えを求めてから届くまで |
|---|---|---|
| 最初の作り | VPC origin を新しく作り、配信の送り先にする | 596 秒 |
| 1 回目の向け直し | 新しい B の組を作り、配信を B に切り替える | 192 秒 |
| 2 回目の向け直し | 配信から外れた A の組を書き換え、配信を A に切り替える | 348 秒 |

ほとんどが、VPC origin が `Deployed` になるまで（約 8 分、約 2 分、約 2.5 分）と、配信の切り替え（約 25 秒〜約 2.5 分）の時間だった。sslip.io の名前を書き換える方法（4-2、約 100 秒）より長い。向け直しの間は、前の組が前の台を指したままなので、台を入れ替えたときは、向け直しが終わるまで届かない。

<details>
<summary>根拠</summary>

- コマンド: `aws/scale.sh down`、`aws/scale.sh up`、`aws/edge-point.sh`（2026-11-19 23:47〜2026-11-20 00:09）。2 回目は、edge-check のタスクを、置き方の制約でもう 1 台へ移してから行った。
- 拒まれたときの理由: `The specified VPC origin is currently associated with one or more distributions. Please disassociate the VPC origin from all distributions before updating or deleting (Service: CloudFront, Status Code: 409 …)`
- 結果: `edge-point.sh` の出力で、スタックの更新 551 秒・188 秒・343 秒、届くまで 596 秒・192 秒・348 秒。

</details>

### 4-10. 配信の既定のドメインを RP ID にして、パスキーを登録し、別のパスの受け口で文書のハッシュに署名できた。cloudfront.net は RP ID にできなかった
**結論:** 配信の既定のドメイン（`dXXXX.cloudfront.net`）を RP ID にして、ログインサーバーの役の受け口（`/login/`）でパスキーを登録できた。同じ資格情報で、顧客のアプリの役の受け口（`/app/`）から、文書の SHA-256 を challenge にして署名できた。サーバーの検証（`@simplewebauthn/server` 13.3.3）は、どちらも RP ID のハッシュ、origin、ユーザーの確認、署名を通した。署名された clientDataJSON の challenge は、文書のハッシュと一致した。RP ID を `cloudfront.net` にして登録を求めると、ブラウザーが `SecurityError` で拒んだ。`cloudfront.net` は Public Suffix List にあるので、別の配信が同じ RP ID を名乗ることはできない。

試しの署名の challenge は、毎回同じ文書のハッシュにした。そのため、同じ署名を出し直されても見分けられない。段 D で署名するハッシュには、申込みごとに変わる値（案や時刻）が入るので、この問題は起きない見込み（推定）。

<details>
<summary>根拠</summary>

- 試した環境: Windows の Microsoft Edge、認証器は Windows Hello（持ち主が操作した。2026-11-19 23:45〜23:47）。
- 結果: 登録は `verified: true`、`device_type: singleDevice`、`backed_up: false`、`user_verified: true`。署名は `verified: true`、`challenge_is_document_hash: true`、`new_counter: 1`。サーバーのログの `passkey_registered` と `passkey_signed` も同じ値。
- `cloudfront.net` のとき: `SecurityError: The relying party ID is not a registrable domain suffix of, nor equal to the current domain. Subsequently, an attempt to fetch the .well-known/webauthn resource of the claimed RP ID failed.` Edge は、拒む前に、別の名前を許す仕組み（Related Origin Requests）のファイルを取りに行っていた。

</details>
### 4-11. t4g.medium 1 台に Keycloak と認可サーバーが載り、台が 0 の状態から約 6〜7 分で使えた。いちばん長いのは VPC origin の向け直しだった
**結論:** 段 C の C-3 を 3 回測り、3 回とも予測（台を起こしてから使えるまで 10 分以内）の内に収まった。終点は 369 秒、370 秒、402 秒。測り方の定義は [log.md の 2026-11-20 の決定](log.md#決めたこと) のとおりで、VPC origin の向け直しを含む。全部のサービスが t4g.medium 1 台に載り、10 分置いても、メモリの不足で止まったタスクは 0 件だった。

時間の内訳では、向け直し（約 3〜4 分）がいちばん長かった。台が ASG に加わるまでが約 2 分、Keycloak と auth の起動は、それぞれ台の上で数十秒だった。入口を内部向けの ALB にすると、向け直しが要らなくなる（[design-decisions](design-decisions.md)）。その場合、使えるまでは約 4 分になる見込み（推定。auth の起動の約 220 秒に、ALB のターゲットの登録と健康の確認の時間が足される）。

メモリの最大は、Keycloak が約 530 MiB（上限 1 GiB）、auth が約 200 MiB（上限 512 MiB）だった。全部のタスクを合わせると約 1.1 GB で、t4g.small の物理のメモリには収まる値だった。ただし、今のメモリの上限（Keycloak 1 GiB、auth 512 MiB）では、t4g.small に置けない（4-14 の台で、auth が `RESOURCE:MEMORY` で置けなかった）。t4g.small は試していない。要求を流さずに置いただけなので、負荷をかけたときのメモリは分からない。

<details>
<summary>根拠</summary>

- コマンド: `GEKKO13_INSTANCE_TYPE=t4g.medium GEKKO13_MAX_HOSTS=1 GEKKO13_CONTAINER_INSIGHTS=enabled aws/deploy.sh …`、`aws/c3-measure.sh`（2026-11-20、コミット `20e83ce` のイメージ）。1 回目のあとに 10 分置いた（30 分から縮めた。[log.md](log.md#決めたこと)）。
- 結果（始点からの秒）:

| 回 | 台が ASG に加わった | Keycloak の起動（ログ） | auth の起動（ログ） | 終点 |
|---|---|---|---|---|
| 1 | 114 | 164 | 230 | 369 |
| 2 | 112 | 175 | 213 | 370 |
| 3 | 112 | 193 | 217 | 402 |

- 向け直しは、edge-check が RUNNING になった時刻（160〜168 秒）に始め、スタックの更新が 192 秒、193 秒、223 秒だった。どの回も、更新が終わってから 5 秒以内に、Keycloak の discovery が配信の名前を issuer にして返った。
- メモリの最大（Container Insights の `MemoryUtilized`、1 分ごとの最大、1 回目の 10 分）: keycloak 528、auth 205、bff・transfer・ledger 各 81、edge-check 41、spire-server 20（MiB）。spire-agent（DAEMON）は測っていない。
- 止まったタスク: spire-agent が 1 件（`Essential container in task exited`）。台を起こした直後に、agent が server より先に起きて止まる既知の動き（推定。agent のログでは確かめていない）。
- auth の起動は、ECS が RUNNING を返す時刻より早いことがあった（2 回目は 213 秒と 224 秒）。ECS の状態の取り込みが遅れるためとみられる（推定）。
- Keycloak は `start --optimized` と dev-file で起きた。ローカルの x86 の機械では、起動から discovery が返るまで 27 秒、メモリは約 675 MiB だった（上限 1 GiB）。

</details>

### 4-12. 日本語のコメントを含めた ECS のテンプレートは、直接送れる大きさ（51,200 バイト）を超えた
**結論:** auth と keycloak を足した ECS のテンプレートは 53,221 バイトで、`aws cloudformation deploy` は「51,200 バイトを超えるテンプレートは S3 のバケットから送る」と拒んだ。日本語は 1 文字 3 バイトなので、コメントが大きさの多くを占める。`aws/deploy.sh` は、送る前に行頭のコメントだけを除く（45,997 バイト）。S3 のバケットは足していない。

<details>
<summary>根拠</summary>

- コマンド: `aws/deploy.sh`（2026-11-20、コミット `b5f2368`）。エラー: `Templates with a size greater than 51,200 bytes must be deployed via an S3 Bucket.`
- 大きさは `wc -c` で測った。コメントを除くのは、`grep -v -E '^[[:space:]]*# '`（UserData のシバン `#!` は残る）。

</details>

### 4-13. spiffe-helper は root で動き、鍵を 0600 で書いたので、root でない利用者のアプリは鍵を読めなかった
**結論:** AWS の上の auth（利用者 1000 で動く）は、`/svid/svid_key.pem` を読めずに起動に失敗した。spiffe-helper のイメージは root で動き、鍵を既定の 0600 で書く。ローカルでは helper を auth と同じ利用者で動かしていた（`local/up.sh`）ので、この食い違いが出なかった。helper の設定に `key_file_mode = 0640` を足して鍵のグループを root にし、auth を `1000:0` で動かすと、読めた。Node のサービスは root で動くので、影響しない。

<details>
<summary>根拠</summary>

- エラー: `Unable to create key store: Error reading certificate or key from file 'file:/svid/svid_key.pem'`（2026-11-20）。
- spiffe-helper 0.11.0 は `cert_file_mode` と `key_file_mode` を受け付けた（手元で、知らない設定だけを `unknown top level key(s)` で拒むことで確かめた）。
- 直したあと: `Started AuthApplication in 5.477 seconds`。

</details>

### 4-14. ECS のスタックの更新が止まる前に起きた台は、古い起動テンプレートのまま残った
**結論:** `aws/deploy.sh` は、ECS のスタックを更新する前に、spire-server のタスク数を 1 に戻す（2-9 の対策）。4-12 で更新が送られずに止まったときも、タスク数は 1 になったので、キャパシティプロバイダーが古い起動テンプレート（t4g.small）で台を起こした。そのあと更新が通っても、起きていた台は t4g.small のままで、上限 1 台の下で auth が `RESOURCE:MEMORY` で置けず、スタックの更新が待ち続けた。台を 0 にすると、更新は終わった。起動テンプレートを変える更新のあとは、台を 0 にしてから起こし直す。

<details>
<summary>根拠</summary>

- 2026-11-20。ECS のサービスのイベント: `was unable to place a task. Reason: TaskFailedToStart: RESOURCE:MEMORY`。台の登録メモリは 1,846 MiB、残りは 182 MiB だった。
- `aws/scale.sh down` のあと、`Successfully created/updated stack - gekko13-ecs`。

</details>
### 4-15. 入口を内部向けの ALB にすると、台が 0 の状態から約 3 分で使え、2 つの AZ のどちらの台にも届いた
**結論:** 段 D の D0 を 3 回測り、3 回とも予測（300 秒以内）に収まった。終点は 193 秒、178 秒、166 秒で、C-3（369〜402 秒、[4-11](#4-11-t4gmedium-1-台に-keycloak-と認可サーバーが載り台が-0-の状態から約-67-分で使えたいちばん長いのは-vpc-origin-の向け直しだった)）の半分ほどになった。VPC origin の向け直しがなくなったためである。どの回も、CloudFront を通した edge-check の応答に、2 つの AZ（ap-northeast-1a と ap-northeast-1c）が現れた。

最後に待ったのは、3 回とも auth の起動だった。auth は、SPIRE server が動き、SVID が書かれてから起動するので、server の起動を待つ分だけ遅れる（推定）。Keycloak は、ALB が健康と判定するより前に、CloudFront から応えることがあった。ALB は、健康なターゲットが 1 つもないとき、全部のターゲットに送る（fail open）ためとみられる（推定）。

<details>
<summary>根拠</summary>

- コマンド: `GEKKO13_AZS=2 GEKKO13_INSTANCE_TYPE=t4g.medium GEKKO13_MAX_HOSTS=2 aws/deploy.sh`、`aws/d0-measure.sh`（2026-11-20〜21、コミット `9637703`）。測り方の定義は [log.md](log.md#決めたこと) の 2026-11-21 の決定。
- 結果（始点からの秒）:

| 回 | 台が ASG に加わった | Keycloak が応えた | 2 つめの AZ が応えた | 終点（auth の起動） |
|---|---|---|---|---|
| 1 | 109 | 182 | 183 | 193 |
| 2 | 89 | 162 | 153 | 178 |
| 3 | 70 | 155 | 125 | 166 |

- 0 台から起こすと、どの回も 2 台が同じ時刻に ASG に加わった。edge-check の 2 タスクを別の台に置く制約（distinctInstance）で、2 台が要ると見積もられたとみられる（推定）。
- 1 回目は、Keycloak が CloudFront から応えたのが 182 秒で、ALB のターゲットが健康になったのは 202 秒だった（`describe-target-health`）。
- ECS が RUNNING を返す時刻は、CloudFront から応えた時刻より遅いことがあった（4-11 と同じ）。
- デプロイのあとの確かめで、`/edge-point` を 8 回呼ぶと、2 つの AZ に 4 回ずつ届いた。

</details>

### 4-16. ALB を指す VPC origin を作るのに約 9 分、配信の切り替えに約 1 分、古い VPC origin を消すのに約 7 分かかった
**結論:** 入口を、台を指す VPC origin の 4 つ（A と B の組）から、ALB を指す VPC origin 1 つに作り替えた。1 回のスタックの更新で、CloudFormation は新しい VPC origin を作り、配信を切り替え、古い 4 つを並べて消した。切り替えの間も、配信の名前（RP ID）は変わらなかった。VPC origin を作るのと消すのは、どちらも数分かかるので、ALB は作り直さない（[design-decisions](design-decisions.md)）。

<details>
<summary>根拠</summary>

- スタック `gekko13-edge` の出来事（2026-11-20、UTC）: `AlbVpcOrigin` の作成 15:27:18〜15:36:30、`Distribution` の更新 15:36:32〜15:37:37、古い 4 つの削除 15:37:39〜15:44:48。
- 切り替えのあとも、`DomainName` は前と同じだった。

</details>

### 4-17. 入口の中継（Web Functions）は、NetworkConnector の先から名前空間の SRV を引き、2 つの AZ のタスクに届いた。本文付きの POST と複数の Set-Cookie が通り、エンドポイントを直接呼ぶと 403 だった
**結論:** CloudFront から、OAC で署名して Web Functions の中継を呼び、中継が名前空間 `svc.gekko13.internal` の SRV を VPC の DNS で引いて、タスクへ送った。Lambda の資料は、VPC に関連づけたプライベートのホストゾーンが引けるとだけ書き、Cloud Map の名前空間には触れていない。実際には、Cloud Map の名前空間の SRV も引けた。

| 確かめたこと | 結果 |
|---|---|
| `/edge-point` を 6 回 | 6 回とも 200。AZ は 2 種類（1a が 4 回、1c が 2 回） |
| Keycloak の discovery | 200。issuer は配信の名前 |
| Keycloak のトークンの受け口へのフォームの POST（知らない client） | 401 の `invalid_client`。本文の `client_id` が Keycloak に届いた |
| Keycloak の認可の画面 | 200。Set-Cookie が 3 つとも、属性（Path、HttpOnly、SameSite）ごと届いた |
| 中継のエンドポイントを、署名なしで直接 | 403 |

中継の記録では、11 件の要求がすべて 1 回めの送り先で通り、送り直しもエラーも 0 件だった。中継の中の時間は 2〜34 ms、Keycloak の最初の認可の要求だけが 149 ms だった。実行環境の起動は 340 ms、メモリは 141 MB だった。

<details>
<summary>根拠</summary>

- コマンド: `curl https://<配信の名前>/edge-point`（6 回）、`curl` で discovery、トークンの受け口（`grant_type=client_credentials`）、認可の受け口（`client_id=gekko13-app`、PKCE つき）、エンドポイントの名前への直接の `curl`（2026-11-21 05:46〜05:50 UTC）。
- 中継の記録: `/aws/lambda/web/gekko13-entry` の `proxied` の行の `ms` と `attempt`、`platform.initReport` の `totalDurationMs` と `maxMemoryUsageMb`。
- 実行環境の版: `nodejs24.x:nodejs.web24.v22`。zip の中は、`scripts/stage-entry.sh` が TypeScript から変えた JavaScript（コミット `f76be6a`）。

</details>

### 4-18. NetworkConnector の操作ロールと Web Functions の実行ロールは、信頼ポリシーに aws:SourceAccount の条件があると、Lambda に引き受けられなかった
**結論:** どちらのロールも、主体を `lambda.amazonaws.com` にし、`aws:SourceAccount` を自分のアカウントに限る条件を付けた。NetworkConnector の作成は「The service is unable to assume the provided NetworkConnectorOperatorRole」で拒まれた。条件を外して作り直すと、NetworkConnector は通った。次に、リビジョンの作成が「The execution role ... cannot be assumed by lambda.amazonaws.com」で拒まれ、こちらも条件を外すと通った。Lambda の資料の操作ロールの信頼ポリシーにも、gekko_10 の実行ロールにも、条件はない。EC2 のロール（`ec2.amazonaws.com`）では、同じ条件で問題なく動いている。 <!-- check-docs: 残す エラーの文言をそのまま引くため -->

<details>
<summary>根拠</summary>

- スタック `gekko13-entry` の出来事（2026-11-21、UTC）: `Connector` の CREATE_FAILED（04:55:30）、`Revision` の CREATE_FAILED（05:21:36）。直したコミットは `3572866` と `0078b45`。
- 資料: https://docs.aws.amazon.com/lambda/latest/dg/web-functions-networking.html の「Operator role permissions」（2026-11-21 に読んだ）。

</details>

### 4-19. CloudFront は、Web Functions の送り先の OAC に、署名の仕方 always を拒み、always-amz-auth を求めた
**結論:** OAC の `SigningBehavior` を `always` にすると、配信の更新が「Lambda-Web origins require always-amz-auth signing behavior」で拒まれ、配信のスタックは前の状態に巻き戻った。CloudFormation の型は、`never`、`no-override`、`always`、`always-amz-auth` のどれも受け付けるので、型の検査では見つからない。Lambda の資料と gekko_12 の実測 3-8 は、`always-amz-auth` と書いている。 <!-- check-docs: 残す エラーの文言をそのまま引くため -->

<details>
<summary>根拠</summary>

- スタック `gekko13-edge` の出来事（2026-11-21 05:41 UTC）: `Distribution` の UPDATE_FAILED。直したコミットは `f36f273`。

</details>

### 4-20. NetworkConnector を作るのに約 4 分、中継のリビジョンとエンドポイントは十数秒、配信の切り替えに約 3 分かかった
**結論:** 入口の中継のスタックは、作り始めから約 5 分でできた。ほとんどが NetworkConnector（ENI を 2 つの AZ に作る）の時間だった。リビジョンは約 4 秒、エンドポイントは約 8 秒だった。止めてあった配信を、送り先を中継に替えて有効にするのに約 3 分かかった。どれも、作るときに一度だけかかる時間で、使わない間は消さないので、戻すときにはかからない。巻き戻しで NetworkConnector を消すのには、約 2 分かかった。

<details>
<summary>根拠</summary>

- スタック `gekko13-entry` の出来事（2026-11-21、UTC）: `Connector` 05:36:13〜05:40:29、`Revision` 05:40:31〜05:40:35、`Endpoint` 05:40:36〜05:40:44。
- スタック `gekko13-edge` の出来事: `Distribution` 05:42:21〜05:45:27。
- 巻き戻し: `Connector` の DELETE_COMPLETE は 04:57:47（CREATE_FAILED の約 2 分後）。

</details>

### 4-21. 入口を Web Functions の中継にしても、台が 0 の状態から約 3〜4 分で使え、2 つの AZ のどちらの台にも届いた。台が 0 の間、配信は 503 を返した
**結論:** D0-b の「台が 0 から使えるまで」を、D0 と同じ定義で 3 回測った。終点は 220 秒、246 秒、184 秒で、3 回とも 300 秒以内、毎回 2 つの AZ が現れた。plan.md の予測（約 4 分）どおりだった。ばらつきの多くは、台が ASG に加わるまでの時間（75〜152 秒）だった。edge-check は、RUNNING になってから 2〜3 秒で、CloudFront から届いた。ALB の D0（166〜193 秒。[4-15](#4-15-入口を内部向けの-alb-にすると台が-0-の状態から約-3-分で使え2-つの-az-のどちらの台にも届いた)）と比べて、入口による遅れは見えなかった。

台を 0 にしている間も、配信は有効なまま、中継が 503 の `no target` を返した。測定の間の中継の記録は、次のとおりである。

| 数えたもの | 件数 |
|---|---|
| `no target`（503） | 292（台が 0 の間と、タスクが登録される前） |
| 送り先へ中継した要求 | 85（すべて 1 回めの送り先で通った） |
| 送り先につながらなかった要求（502） | 0 |

中継の中の時間は、中央値 5 ms、最大 179 ms だった。実行環境は、20 分の間に 1 回だけ起き（330 ms）、そのまま使われ続けた。

<details>
<summary>根拠</summary>

- コマンド: `aws/scale.sh down` と `aws/d0-measure.sh` を 3 回（2026-11-21 05:53〜06:14 UTC、コミット `69f8f61`）。結果は `local/run/d0/20261121T055522Z`、`20261121T060300Z`、`20261121T061100Z` の `result.md`。
- 内訳（始点からの秒。1 回目、2 回目、3 回目）: 台が ASG に加わった 128、152、75。edge-check が RUNNING 178、203、140。CloudFront を通して Keycloak が応えた 220、236、152。auth の起動（ログの時刻）は、3 回目が 184 で終点を決めた。
- 中継の記録: `/aws/lambda/web/gekko13-entry` の `no-target`、`proxied`、`upstream-failed` の行を数えた（05:53 UTC 以降）。

</details>

### 4-22. 名前空間の DNS は、全部のタスクが UNHEALTHY のとき、UNHEALTHY のタスクも返した
**結論:** 3 回目の測定の間、3〜5 秒ごとに 3 つを記録した。edge-check の 2 つのタスクの健康、健康なインスタンスだけを返す API（`discover-instances`）の件数、CloudFront を通した `/edge-point` の状態である。ECS は、タスクをはじめ UNHEALTHY として登録した。2 つとも UNHEALTHY の間、`discover-instances` は 0 件を返したが、CloudFront を通すと 200 が返った。中継が引く DNS は、UNHEALTHY のタスクも返したことになる。1 つが HEALTHY になると、`discover-instances` も 1 件になった。

Route 53 の複数値の答えが、全部が健康でないときに全部を返す動きと合う（推定）。全部が健康になったあとで、DNS が UNHEALTHY のタスクを外すかは確かめていない。影響として、タスクが起きかけの間は、健康の確かめを通る前のタスクにも要求が届く。待ち受けの前なら、中継は送り直し、それでもつながらなければ 502 を返す。この測定では 502 は 0 件だった。タスクが 1 つしかないサービスでは、健康でなくなったタスクにも送り続ける。

<details>
<summary>根拠</summary>

- 記録（2026-11-21、UTC）: 06:13:18 に 2 つとも UNHEALTHY、`discover-instances` は 0、CloudFront は 503。06:13:23 に 2 つとも UNHEALTHY のまま、CloudFront は 200。06:14:06 に 1 つが HEALTHY、`discover-instances` は 1。06:14:16 に 2 つとも HEALTHY、`discover-instances` は 2。
- コマンド: `aws servicediscovery get-instances-health-status`、`aws servicediscovery discover-instances`、`curl https://<配信の名前>/edge-point` を、3 秒の間を置いて繰り返した。

</details>

### 4-23. 台を全部スポットにしても、2 つの AZ に台が起き、台が 0 の状態から約 3 分半で使えた。1a では t4g.large が選ばれた
**結論:** ASG を、オンデマンドを 0 台にし、4 つの種類（t4g.medium、c6g.large、c7g.large、t4g.large）を `price-capacity-optimized` で選ぶ形にした。台は 2 回起こし、2 回とも 2 台ともスポットで起きた。1c は t4g.medium、1a は t4g.large だった。1a では、t4g.medium より高い t4g.large が選ばれたことになる。空きの多さを優先したと見られる（推定）。D0-b の測り方で 1 回測ると、終点は 204 秒で、2 つの AZ が現れた。オンデマンドの 3 回（184〜246 秒。[4-21](#4-21-入口を-web-functions-の中継にしても台が-0-の状態から約-34-分で使え2-つの-az-のどちらの台にも届いた台が-0-の間配信は-503-を返した)）の幅に収まった。中断は、この間には起きなかった。

<details>
<summary>根拠</summary>

- コマンド: `aws/deploy.sh`（コミット `e820719`）、`aws ec2 describe-instances` の `InstanceType`、`InstanceLifecycle`、`Placement.AvailabilityZone`、`aws/scale.sh down`、`aws/d0-measure.sh`（2026-11-21 06:39〜07:00 UTC）。結果は `local/run/d0/20261121T065325Z/result.md`。
- 内訳（始点からの秒）: 台が ASG に加わった 120、edge-check と keycloak が RUNNING 182、CloudFront を通して 2 つの AZ の edge-check が応えた 194、Keycloak が応えた 204、auth の起動（ログの時刻）204。
- スポットの価格（東京、2026-11-21、1 時間あたり）: t4g.medium は 1a 0.0170 ドル、1c 0.0188 ドル。t4g.large は 1a 0.0327 ドル、1c 0.0300 ドル（`aws ec2 describe-spot-price-history`）。

</details>

## 5. 未確認
- AZ がまるごと落ちたときと、server のタスクや台が突然消えたときに、server が何分で起き直すか（3-5）。移し先に台がなければ、台を起こすところから始まる。
- 0 台から起こすとき、マネージドスケーリングがなぜ 2 台と見積もるか（3-2）。
- 台の IPv6 のアドレスへ、インターネットから直接つなぐと拒まれるか（4-8）。EIGW とセキュリティグループの作りから届かないと判断したが、手元から IPv6 で外に出られず、試していない。
- VPC origin が `Deployed` になるまでの時間のばらつき（4-9 では約 2〜8 分）。回数が 3 回と少ない。
- ある台で、IPv6 で公開したポートが拒まれた原因（4-3）。VPC origin に替えてからの 3 回の向け直しでは、起きなかった。
- ECS 用の AMI のルートの容量が 30 GB で足りるか、小さくできるか。
- Java のサービスが外を呼ぶ側の mTLS（要求ごとにつなぎ直し、そのときの SVID で示すか）。C-4 では、呼び手は Node だった。段 D で、Java のサービスが別のサービスを呼ぶときに確かめる。
- t4g.small に、メモリの上限を下げて全部が載るか（4-11）。物理のメモリには収まる値だったが、試していない。
- 要求を流したときの、Keycloak と auth のメモリ（4-11 は、置いただけの値）。段 D でシナリオを流すときに見る。
