# 実機で確かめた事実

**この文書の読み手:** 実機で確かめた個別の事実を調べに来た開発者と AI エージェント。扱うのは、第 2 部の基盤（ECS on EC2、SPIRE、IPv6 だけの AWS）と、第 2 部で確かめたこと。検証の計画と合格の基準は [plan.md](plan.md)、経過は [log.md](log.md)、判断の理由は [design-decisions.md](design-decisions.md)。用語は [用語集](glossary.md)。

各項目は、**結論**（見出しと数行）と、**根拠**（コマンド・出典・取得日）に分けて書く。1〜3 節は、第 1 部（2026-11-15〜18）で確かめた基盤の事実で、第 2 部でも使い続ける。1 節の一部はローカルの docker で、ほかは AWS の東京リージョンで確かめた。第 2 部で確かめたことは、4 節から足す（4 節は段 C）。環境は次のとおり。

| 部品 | 版 |
|---|---|
| SPIRE | 1.15.3 |
| spiffe-helper | 0.11.0 |
| Node.js | 24 |
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

## 5. 未確認
- AZ がまるごと落ちたときと、server のタスクや台が突然消えたときに、server が何分で起き直すか（3-5）。移し先に台がなければ、台を起こすところから始まる。
- 0 台から起こすとき、マネージドスケーリングがなぜ 2 台と見積もるか（3-2）。
- CloudFront を通らずに、台の IPv6 の 8080 へ直接つなぐと拒まれるか（4-1）。手元から IPv6 で外に出られず、確かめていない。セキュリティグループは、CloudFront の送り先向けのアドレスからだけを受ける。
- ある台で、IPv6 で公開したポートが拒まれた原因（4-3）。
- ECS 用の AMI のルートの容量が 30 GB で足りるか、小さくできるか。
