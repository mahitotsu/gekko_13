# 実機で確かめた事実

**この文書の読み手:** 実機で確かめた個別の事実を調べに来た開発者と AI エージェント。扱うのは、第 2 部の基盤（ECS on EC2、SPIRE、IPv6 だけの AWS）と、第 2 部で確かめたこと。検証の計画と合格の基準は [plan.md](plan.md)、経過は [log.md](log.md)、判断の理由は [design-decisions.md](design-decisions.md)。用語は [用語集](glossary.md)。

各項目は、**結論**（見出しと数行）と、**根拠**（コマンド・出典・取得日）に分けて書く。1〜3 節は、第 1 部（2026-11-15〜18）で確かめた基盤の事実で、第 2 部でも使い続ける。1 節の一部はローカルの docker で、ほかは AWS の東京リージョンで確かめた。第 2 部で確かめたことは、4 節（段 C）と 5 節（段 D）に足す。環境は次のとおり。

| 部品 | 版 |
|---|---|
| SPIRE | 1.15.3 |
| spiffe-helper | 0.11.0 |
| Node.js | 24 |
| Java、Spring Boot、Spring Authorization Server | 21（Eclipse Temurin）、3.5.16、1.5.8 |
| AWS CLI | 2.38.1 |
| ローカルの docker | 29.1.3（WSL2、cgroup v2） |
| AWS のインスタンス | t4g.small、ECS 用の Amazon Linux 2023（arm64）の推奨の AMI |

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
| 2-11 | IPv6 だけのインスタンスは、Session Manager に登録されなかった |
| 3-1 | agent の DAEMON だけが残ったインスタンスを、マネージドスケーリングは空として縮めた |
| 3-2 | 0 台から起動するとき、マネージドスケーリングは 2 台を起動した |
| 3-3 | インスタンスを 0 にして再起動しても、EFS の上の SPIRE の CA と登録は残った |
| 3-4 | server が 5 分ほどいないと、agent は自分の SVID が切れて止まった |
| 3-5 | SPIRE server を別の AZ へ移すと、server は 24 秒いなかったが、連鎖の失敗は 0 件で、CA も変わらなかった |
| 3-6 | SPIRE server を冗長にするには、全部の server が 1 つの SQL のデータストアを共有する。DynamoDB は使えない |
| 3-7 | Aurora Serverless v2 は 0 ACU まで縮み、つながりが 1 本でもあると止まらない |
| 4-1 | CloudFront は、送り先の IP の種類を ipv6 にすると、IPv6 だけのインスタンスに届いた。既定の ipv4 では届かなかった |
| 4-2 | インスタンスが入れ替わると、送り先を向け直すまで届かず、向け直してから約 100 秒で届いた |
| 4-3 | あるインスタンスで、IPv6 で公開したポートが、ある時間だけ拒まれた。原因は分からない |
| 4-4 | Spring Authorization Server は、Envoy なしで SVID の mTLS を自分で終え、交換したトークンを呼び手の SVID の証明書に結んだ |
| 4-5 | Spring Authorization Server の交換は、元のトークンの保存に利用者がないと、説明なしの invalid_grant で拒んだ |
| 4-6 | SVID が入れ替わると、前の証明書に結んだトークンは、交換の actor_token に使えなくなった |
| 4-7 | SPIRE は、SVID を入れ替えるたびに、鍵の組も新しく作った |
| 4-8 | CloudFront は、プライベートのサブネットのインスタンスに VPC origin で届き、パスで 2 つのエンドポイントに振り分けた。インスタンスから見た送り主は、CloudFront の公開 IPv4 だった |
| 4-9 | CloudFront は、ディストリビューションが使っている VPC origin の更新を拒んだ。VPC origin を 2 組持って切り替えると、向け直しは 3〜6 分だった |
| 4-10 | ディストリビューションの既定のドメインを RP ID にして、パスキーを登録し、別のパスのエンドポイントで文書のハッシュに署名できた。cloudfront.net は RP ID にできなかった |
| 4-11 | t4g.medium 1 台に Keycloak と認可サーバーが載り、インスタンスが 0 の状態から約 6〜7 分で使えた。いちばん長いのは VPC origin の向け直しだった |
| 4-12 | 日本語のコメントを含めた ECS のテンプレートは、直接送れる大きさ（51,200 バイト）を超えた |
| 4-13 | spiffe-helper は root で動き、鍵を 0600 で書いたので、root でない利用者のアプリは鍵を読めなかった |
| 4-14 | ECS のスタックの更新が止まる前に起きたインスタンスは、古い起動テンプレートのまま残った |
| 5-1 | 入口を内部向けの ALB にすると、インスタンスが 0 の状態から約 3 分で使え、2 つの AZ のどちらのインスタンスにも届いた |
| 5-2 | ALB を指す VPC origin を作るのに約 9 分、ディストリビューションの切り替えに約 1 分、古い VPC origin を消すのに約 7 分かかった |
| 5-3 | 入口のリバースプロキシ（Web Functions）は、NetworkConnector の先から名前空間の SRV を引き、2 つの AZ のタスクに届いた。本文付きの POST と複数の Set-Cookie が通り、エンドポイントを直接呼ぶと 403 だった |
| 5-4 | NetworkConnector の操作ロールと Web Functions の実行ロールは、信頼ポリシーに aws:SourceAccount の条件があると、Lambda に引き受けられなかった |
| 5-5 | CloudFront は、Web Functions の送り先の OAC に、署名の仕方 always を拒み、always-amz-auth を求めた |
| 5-6 | NetworkConnector を作るのに約 4 分、リバースプロキシのリビジョンとエンドポイントは十数秒、ディストリビューションの切り替えに約 3 分かかった |
| 5-7 | 入口を Web Functions のリバースプロキシにしても、インスタンスが 0 の状態から約 3〜4 分で使え、2 つの AZ のどちらのインスタンスにも届いた。インスタンスが 0 の間、ディストリビューションは 503 を返した |
| 5-8 | 名前空間の DNS は、全部のタスクが UNHEALTHY のとき、UNHEALTHY のタスクも返した |
| 5-9 | インスタンスを全部スポットにしても、2 つの AZ にインスタンスが起き、インスタンスが 0 の状態から約 3 分半で使えた。1a では t4g.large が選ばれた |
| 5-10 | Aurora の管理者は superuser でなく、ロールへ切り替える権利（SET）がないと、そのロールを持ち主にしたデータベースを作れなかった |
| 5-11 | 2 つの SPIRE server が、空のデータベースに同時にスキーマを作ると、片方がぶつかって止まった。ECS が再起動したあとは通った |
| 5-12 | Keycloak の 2 タスクは、ログインの画面を作ったタスクを止めても、もう片方がセッションを引き継いだ（CloudFront を通して） |
| 5-13 | SPIRE server の片方が止まっても、残った server が、新しいタスクに SVID を出した |
| 5-14 | インスタンスを 1 台、予告なしに止めても、入口のリクエストの失敗は 418 回のうち 1 回だった。代わりの auth は残ったインスタンスに置かれ、AZ が偏った |
| 5-15 | auth の 2 タスクは、同じ署名鍵（同じ鍵の ID）を持った |
| 5-16 | AZ の偏りの直しを有効にすると、偏ったタスクを ECS が並べ直した。`MaximumPercent` を 200 % にすると、ローリングアップデートの間にインスタンスが 1 台増えた |
| 5-17 | Aurora と冗長化を足しても、インスタンスが 0 の状態から約 3 分半〜4 分で使えた。Aurora は、つながりがなくなって 5 分ほどで一時停止し、再開は 5 秒ほどだった |
| 5-18 | 認可の記録をデータベースに置くと、`java.lang.Long` の値を含む記録は読み戻せなかった |
| 5-19 | Keycloak 26.8.2 の管理の API は、トークンにクライアントスコープ `kc-admin-api` の宛先を求めた。スコープは、レルムの JSON に定義しないと、取り込みで割り当てられなかった |
| 5-20 | CloudFront とリバースプロキシの後ろの Keycloak は、DPoP の `htu` を、届いた要求の URL（http と、CloudFront が替えた Host）で照らし、認可コードの交換を断った |
| 5-21 | `aws cloudformation deploy` は、渡さないパラメーターに前の値を使い続けた。scale.sh down が 0 にしたオートスケーリングの幅も、スタックの更新では戻らなかった |
| 5-22 | 手元で、主の流れの 2〜7 段が、Envoy なしで通った。サービスのトークンの確かめは、TypeScript、Python、Java の 3 つで、共通の例 15 件の判定が全部一致した |
| 5-23 | AWS でも、主の流れの 2〜7 段が CloudFront を通して通った。同時に作った Service Connect のサービスどうしは、タスクを入れ替えるまで、互いの名前を引けなかった |
| 5-24 | AWS でも、監査の画面で、主の流れの契約が「食い違いなし」と出た。書いた者は、ログストリームの名前で決められた。最初の作りでは、一覧の画面が入口の待ちの上限を超えた |
| 5-25 | gekko_11 から写した作りは、利用者の役割を監査の画面でしか確かめず、監査の担当も顧客のアプリを使えた。Keycloak のクライアントごとの認証の流れで、役割のない利用者をログインの画面で止められた |

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
**結論:** ASG が起動したインスタンスの agent は、どちらも aws_iid の確認を通った。登録のノードのセレクターは `aws_iid:tag:gekko13-role:ecs-host` の 1 つで、インスタンスがいくつでも足りた。agent は、Cloud Map の A レコードの名前（`spire-server.svc.gekko13.internal`）で、awsvpc の server に届いた。

<details>
<summary>根拠</summary>

- 結果: server のログに、2 台の agent の `Agent attestation request completed`。続けて、agent が bff、transfer、ledger の SVID を作った（`Creating X509-SVID`）。

</details>

## 2. AWS で作るときに当たること
### 2-1. CloudFormation は、テンプレートの ASCII 以外の文字を「?」に置き換えた
**結論:** 日本語で書いたテンプレートの `Description`、パラメーターの `Description`、`Metadata` は、AWS の上では文字ごとに「?」になった。AWS CLI は UTF-8 のまま送っていた。JSON のテンプレートで日本語を `\u` のエスケープで書き、リクエストを ASCII だけにしても「?」が返ったので、置き換えは CloudFormation の側で起きている。YAML のコメントも、保存されたテンプレートの本文の中では同じく化ける。そのため、テンプレートの説明と Metadata は英語で書き、日本語の理由はリポジトリの `#` のコメントに置く。`scripts/check-templates.sh` が、コメント以外の行の ASCII 以外の文字を止める（`npm test` と `aws/deploy.sh` から呼ぶ）。

<details>
<summary>根拠</summary>

- コマンド: `aws cloudformation describe-stacks --query 'Stacks[0].Description'`、`aws cloudformation get-template`、`aws cloudformation validate-template --debug`
- 結果: `--debug` のリクエストの `TemplateBody` は日本語のまま、応答の XML は `<Description>??????</Description>` だった。`{"Description":"日本語", ...}` の検証は `"???"` を返した。
- 英語に直した registry、network、cognito のスタックは、変更セットがどれも Metadata の変更（置き換えなし）で、更新のあとは説明を読めた。

</details>

### 2-2. ip6tables を書いた daemon.json で、ECS 用の AMI の docker が起動しなかった
**結論:** ユーザーデータで `/etc/docker/daemon.json` に `ipv6`、`fixed-cidr-v6`、`ip6tables` を書いて docker を再起動すると、docker が起動に失敗した。docker が動かないので ECS のエージェントも動かず、インスタンスはクラスターに登録されなかった。`"experimental": true` を足すと、docker は起動し、インスタンスは ECS に登録された。原因は、AMI の docker が 27 より前の版で、`ip6tables` に experimental が要るためと推定している（docker の journal は見ていない）。

<details>
<summary>根拠</summary>

- AMI: `/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id`（2026-11-16 の値）
- コマンド: `aws ec2 get-console-output --latest`
- 結果: `systemctl restart docker` の直後に `Job for docker.service failed`、`Failed to run module scripts-user`。ECS のクラスターのコンテナインスタンスは 0 件で、サービスは `No Container Instances were found` を出し続けた。同じ出力に、SSM Agent の `unable to acquire credentials` もあった。
- `"experimental": true` を足した版（コミット `ae821af`）では、2 台とも ECS に登録された。

</details>

### 2-3. 既定の AWS の名前は IPv4 だけで、デュアルスタックの名前に向けると、公開 IPv4 なしで動いた
**結論:** 東京リージョンの既定の名前（`ecs`、`logs`、`ec2`、`ssm` の `*.amazonaws.com`、イメージの取得先 `<アカウント>.dkr.ecr.*.amazonaws.com`）には、IPv6 のアドレスがなかった。デュアルスタックの名前（`*.api.aws`、`<アカウント>.dkr-ecr.*.on.aws`）には、あった。次のように向けると、公開 IPv4 も NAT もないまま動いた。動いたのは、次のものである。インスタンスの登録、イメージの取得、ログの送信、Service Connect の Envoy、EFS、SPIRE server からの EC2 の API の呼び出し。
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
**結論:** ログの送り先を変える `awslogs-endpoint` をタスク定義の `LogConfiguration` に書くと、`Log driver awslogs disallows options: awslogs-endpoint` でタスク定義を作れなかった。awslogs のドライバーは docker のデーモンの中で動く。そこで、ユーザーデータで docker の systemd の設定に `AWS_ENDPOINT_URL_CLOUDWATCH_LOGS=https://logs.<リージョン>.api.aws` を渡すと、IPv6 だけのインスタンスからログが届いた。

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
**結論:** 入れ替えの試験（3-5）で、spire-server のサービスに「今の AZ 以外に置く」配置制約を外から付けた。そのあと 1 つの AZ の作りに戻してスタックを更新しても、テンプレートに制約の項目を書いていないので、CloudFormation は制約を残したままにした。制約に合うインスタンスがないので、server のタスクは置き場を待ち続け（`PROVISIONING`）、スタックの更新もサービスの安定を待ち続けた。外から変える項目は、変えた手順の側で元に戻す。`aws/run-scenarios.sh` は、server を移し終えたらすぐに制約を外し、`aws/deploy.sh` は、更新の前に制約が残っていれば外す。

<details>
<summary>根拠</summary>

- コマンド: `aws ecs describe-services --services spire-server --query 'services[0].placementConstraints'`（2026-11-18）
- 結果: `memberOf`、`attribute:ecs.availability-zone != ap-northeast-1a` が残っていた。インスタンスは 2 台とも ap-northeast-1a で、メモリと ENI には空きがあった。

</details>

### 2-10. CloudFormation が更新しているサービスに新しいデプロイを強制すると、スタックの更新が失敗して巻き戻った
**結論:** CloudFormation が spire-server のサービスを更新している最中に、`aws ecs update-service --force-new-deployment` で新しいデプロイを強制した。CloudFormation は、自分が始めたデプロイが置き換えられたとみなし、サービスの更新を失敗にして、スタック全体を巻き戻した。スタックの更新の最中は、そのスタックのサービスに手を出さない。

<details>
<summary>根拠</summary>

- 結果: `SpireServerService UPDATE_FAILED Error occurred during operation 'Replaced by a new service deployment.'`、続けて `UPDATE_ROLLBACK_COMPLETE`（2026-11-18）。巻き戻しのあと、同じ更新を回し直すと通った。

</details>

### 2-11. IPv6 だけのインスタンスは、Session Manager に登録されなかった
**結論:** IPv6 だけのインスタンスの SSM Agent は、インスタンスプロファイルの認証情報を取れず、Systems Manager に登録されなかった。Session Manager でインスタンスに入ることはできない。インスタンスの中を見る必要があるときは、作業の間だけ公開 IPv4 を付けるなどの手が要る（未確認）。

<details>
<summary>根拠</summary>

- コマンド: `aws ssm describe-instance-information`（2026-11-18）
- 結果: 登録されたインスタンスは 0 台。インスタンスのコンソールの出力に、`SSM Agent unable to acquire credentials` が出ていた。

</details>

## 3. スケールと SPIRE server
### 3-1. agent の DAEMON だけが残ったインスタンスを、マネージドスケーリングは空として縮めた
**結論:** サービスのタスクを 0 にすると、agent（DAEMON）が 2 台で動いたままでも、`CapacityProviderReservation` はすぐに 0 % になった。台数を決めるこの指標は、DAEMON のタスクを数えない。ECS のコンソールの「実行中のタスク」は DAEMON も数えるので、見え方が違う。縮小のアラームは「100 % 未満が 1 分ごとに 15 回」で働き、1 回に 1 台ずつ（`MaximumScalingStepSize: 1`）縮めたので、0 台まで約 18 分かかった。`aws/scale.sh down` は、タスクが 0 になったら ASG の希望台数を直接 0 にして、この待ちを省く。

<details>
<summary>根拠</summary>

- コマンド: `aws cloudwatch get-metric-statistics --namespace AWS/ECS/ManagedScaling --metric-name CapacityProviderReservation`、`aws cloudwatch describe-alarms`、`aws autoscaling describe-scaling-activities`（2026-11-16〜17）
- 結果: タスクを 0 にした直後から 0 %。`AlarmLow` は `LessThanThreshold 100`、`EvaluationPeriods 15`。2 台から 1 台、1 台から 0 台の縮小は、それぞれ 1 分の間を空けて動いた。

</details>

### 3-2. 0 台から起動するとき、マネージドスケーリングは 2 台を起動した
**結論:** 各サービスが 1 タスクで、1 台のメモリの約 2 割しか使わないのに、0 台から起動すると、2 回とも 2 台を起動した。作成の直後の `CapacityProviderReservation` は 200 % だった。なぜ 2 台と見積もるのかは、分かっていない。

<details>
<summary>根拠</summary>

- 結果: インスタンスごとの残りのメモリは 1,846 MiB のうち 1,526 MiB。`describe-scaling-activities` では、2 台を同時に起動した。

</details>

### 3-3. インスタンスを 0 にして再起動しても、EFS の上の SPIRE の CA と登録は残った
**結論:** SPIRE server のデータストア（sqlite）と鍵を EFS に置くと、インスタンスが 2 台とも入れ替わったあとも、server は同じ CA を読み込んだ。registrar（server のタスクの中で登録を作るコンテナ）は、4 つの登録をどれも作り直さなかった。

<details>
<summary>根拠</summary>

- 結果: 再起動した server のログに `Journal loaded … x509_cas=1` と `X509 CA activated`。`local_authority_id` と `issued_at` は、0 台にする前と同じだった。registrar は 4 件とも `exists` を出した。

</details>

### 3-4. server が 5 分ほどいないと、agent は自分の SVID が切れて止まった
**結論:** server を 0 にしてインスタンスが残っている間、agent は server に届かず（`no children to pick from`）、5 分ほどで `current SVID has already expired` で止まり、ECS の再起動しを繰り返した。agent の SVID の有効期限も、server の `default_x509_svid_ttl`（5 分）に従う。`agent_ttl` を指定しなければ、この値になると資料にある（3-6）。ワークロードの SVID も 5 分なので、server が 1 つの今の作りでは、server が 5 分ほど止まると、どのインスタンスでも mTLS が続けられなくなる（推定）。インスタンスを再起動すときも、agent が server より先に起き、server が起きるまでの約 1 分、止まっては再起動した。

<details>
<summary>根拠</summary>

- コマンド: `aws ecs list-tasks --desired-status STOPPED`、agent のログ（2026-11-16〜17）
- 結果: 止まった agent のタスクは 36 件。大半は server を 0 にしたあとで、再起動しのときは 4 件（`could not open attestation stream`）。

</details>

### 3-5. SPIRE server を別の AZ へ移すと、server は 24 秒いなかったが、連鎖の失敗は 0 件で、CA も変わらなかった
**結論:** 連鎖を呼び続けながら、server を ap-northeast-1a から ap-northeast-1c へ移した（B-4）。移し方は、spire-server のサービスに「今の AZ 以外に置く」制約を付けて、新しいデプロイを強制した。古いタスクが止まり終わってから、新しい server が応答する（registrar の `server is healthy`）まで約 24 秒で、入れ替えを求めてからは約 101 秒だった。新しい server は EFS から同じ CA と 4 件の登録を読み、agent は 1 つも止まらず、連鎖の失敗は 0 件だった。server が戻ったあと、6 つのタスクの SVID は、新しい server の下で入れ替わった。

確かめたのは、計画して止めた入れ替えで、移し先の AZ にインスタンスがすでにあった場合に限る。AZ がまるごと落ちてインスタンスを起動するところから始まる場合と、server のタスクやインスタンスが突然消える場合は、確かめていない。CA の識別子は、前日の段 A のとき（`f29bcd7d…`）とは違っていた。`ca_ttl` が 24 時間なので、その間に SPIRE が CA を入れ替えたと推定している。

<details>
<summary>根拠</summary>

- コマンド: `FAILOVER_AFTER=3 aws/run-scenarios.sh failover 12`（2026-11-18 0:33〜0:47 JST）
- 結果: 古いタスクは 0:39:40 に止まり終わり、registrar は 0:40:04 に `server is healthy`、続けて 4 件とも `exists`。ECS は新しいタスクの開始を 0:40:21 と記録した。`X509 CA activated` の `local_authority_id` は、新旧とも `41ca2056…`。止まった agent は 0 個。`成功 561 回、失敗 0 件`。
- 試験の長さは、移す前 3 分、全体 12 分にした（plan.md の B-4 に長さの決まりはない。経緯は log.md）。

</details>

### 3-6. SPIRE server を冗長にするには、全部の server が 1 つの SQL のデータストアを共有する。DynamoDB は使えない
**結論:** SPIRE の資料によると、server を冗長にするには、同じ信頼ドメインの全部の server が、同じ 1 つのデータストアを読み書きする。データストアは組み込みの SQL のプラグインだけで、SQLite、PostgreSQL、MySQL に対応する。差し替える仕組みはもうないので、DynamoDB は使えない。SQLite は、複数のインスタンスで共有しにくく、本番には一般に勧めないとある。冗長の構成では、server ごとに自分の CA を持つ。`agent_ttl` の既定は `default_x509_svid_ttl` で、その既定は 1 時間。

この資料に、EFS や NFS の上の SQLite についての記述はない。データストアが 1 つなら、server を複数にしても、データストアが止まれば全体が止まる。可用性が上がるのは、server の側（タスク、インスタンス、AZ、更新）が落ちる場合だけになる（推定）。

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
### 4-1. CloudFront は、送り先の IP の種類を ipv6 にすると、IPv6 だけのインスタンスに届いた。既定の ipv4 では届かなかった
**結論:** インスタンスの公開 IPv6 のアドレスを、AAAA だけを返す名前（sslip.io）にして、CloudFront のカスタムの送り先にした。送り先の IP の種類（`CustomOriginConfig` の `IpAddressType`）が既定の `ipv4` のままでは、CloudFront は 502「送り先の名前を解決できなかった」を返した。`ipv6` にすると、インスタンスの上のサービスに届いた。インスタンスから見た送り主は、CloudFront の IPv6 のアドレス（`2600:9000:` で始まる）だった。CloudFront は 2025 年 9 月から IPv6 だけの送り先に対応している。持ち主の指摘で分かり、この検証の最初の調べでは見落とした。

<details>
<summary>根拠</summary>

- 出典: [Amazon CloudFront now supports IPv6 origins](https://aws.amazon.com/about-aws/whats-new/2025/09/amazon-cloudfront-ipv6-origins/)（持ち主が示した。2025-09）
- コマンド: `aws/edge-point.sh`、`curl https://<配信の名前>/`（2026-11-18）
- 結果: `ipv4` のときは `502 … CloudFront wasn't able to resolve the origin domain name.`。`ipv6` のときは、確認用のサービスの JSON（`via_cloudfront: true`）。CloudFormation の型では、`IpAddressType` は `ipv4`、`ipv6`、`dualstack` から選ぶ。

</details>

### 4-2. インスタンスが入れ替わると、送り先を向け直すまで届かず、向け直してから約 100 秒で届いた
**結論:** インスタンスを 0 にして再起動すると、CloudFront の送り先は古いインスタンスの名前のまま残った。そのため、届かなかった（15 秒待っても応答が返らず、のちに 504）。`aws/edge-point.sh` で送り先を新しいインスタンスの名前に書き換えると、書き換えを求めてから約 100 秒で届いた。ほぼすべてが、CloudFormation によるディストリビューションの更新の時間で、更新が終わってからは 1 秒で届いた。

<details>
<summary>根拠</summary>

- コマンド: `aws/scale.sh down`、`aws/scale.sh up`、`aws/edge-point.sh`（2026-11-18 22:09〜22:33）
- 結果: 書き換えから届くまで、98 秒（1 回目）と 99 秒（インスタンスを入れ替えたあと）。どちらも、スタックの更新が 97〜98 秒、そのあと 1 秒。

</details>

### 4-3. あるインスタンスで、IPv6 で公開したポートが、ある時間だけ拒まれた。原因は分からない
**結論:** インスタンスを入れ替えたあと、確認用のサービスが置かれたインスタンスの、IPv6 のアドレスの 8080 に、つなげなくなった。VPC の中の別のインスタンスからつないでも、拒まれた（`ECONNREFUSED`）。同じインスタンスに新しくタスクを起動しても、拒まれた。もう 1 台のインスタンスでは届いた。2 台の起動の記録に違いはなかった。拒まれたインスタンスから SPIRE server（awsvpc）が出ていったあとは、届くようになった。ところが、server がいる別のインスタンスで新しくタスクを起動しても、再現しなかった。インスタンスの中に入れない（2-11）ので、原因は絞り込めていない。入口のタスクを CloudFront に向けるときは、実際に届くかを確かめてから終える必要がある。

<details>
<summary>根拠</summary>

- 試し方: 拒まれたインスタンスを指定して確認用のタスクを起動し、別のインスタンスから、登録していないファミリーのタスク（rogue）の確認役で `fetch("http://[<IPv6>]:8080/")` を送った（2026-11-18 22:24〜22:39）。
- 結果: 拒まれたインスタンスでは、server がいる間に 2 回とも `ECONNREFUSED`。server が出ていったあとは届いた。server がいる別のインスタンスでは、server が来る前に起きたタスクも、来たあとに起きたタスクも届いた。

</details>

### 4-4. Spring Authorization Server は、Envoy なしで SVID の mTLS を自分で終え、交換したトークンを呼び手の SVID の証明書に結んだ
**結論:** 認可サーバー（`services/auth`）は、spiffe-helper が書いた PEM を Spring Boot の SSL バンドルで読み、Tomcat で mTLS を終えた。C-4 の判定の 7 件（C4-1〜C4-7）は、すべて合格した。

- 証明書を示さない呼び手と、別の SVID で名乗った呼び手は、`401 invalid_client` で拒まれた。SPIRE 以外の CA の証明書は、TLS の握手で拒まれた。
- bff の SVID で得たトークンと、交換で得たトークンには、bff の証明書のサムプリントの `cnf.x5t#S256` が入った。交換で得たトークンには、`act.sub`（`bff-client`）も入った。
- bff のトークンを盗んだ transfer が交換を求めると、自分の SVID で正しく認証しても、`invalid_grant` で拒まれた。
- SVID が入れ替わると、認可サーバーは再起動なしで新しい証明書を示した。新しい SVID で得たトークンは、新しいサムプリントに結ばれた。

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

### 4-8. CloudFront は、プライベートのサブネットのインスタンスに VPC origin で届き、パスで 2 つのエンドポイントに振り分けた。インスタンスから見た送り主は、CloudFront の公開 IPv4 だった
**結論:** サブネットの経路表から、IGW への経路をなくした（IPv4 も IPv6 も）。外へは、Egress-only のインターネットゲートウェイ（EIGW）から IPv6 で出る。インスタンスの受信は、同じグループと、CloudFront が VPC に作るグループ（`CloudFront-VPCOrigins-Service-SG`）からだけにした。この作りで、CloudFront は VPC origin を通してインスタンスの上のサービスに届いた。`/login/*` はログインサーバーの役のエンドポイント（8081）に、ほかは顧客のアプリの役のエンドポイント（8080）に届いた。プライベートにしたあとも、インスタンスは ECS に登録され、イメージを取れ、SPIRE の agent と全サービスが安定し、SVID のローテーションも続いた。

予測と違ったのは、インスタンスから見た送り主のアドレスである。VPC の中の IPv4 を予測したが、実際は CloudFront の公開 IPv4（`54.239.` で始まる）だった。CloudFront は、サブネットに自分が管理する ENI（プライベートの IPv4 と IPv6 を持ち、公開のアドレスは持たない）を 1 つ作っていた。この ENI を通るときに、送り主のアドレスを書き換えていないとみられる（推定）。インスタンスは公開 IPv4 を持たず、サブネットに IGW への経路もない。そのため、インターネットからインスタンスに届く道はない（作りからの判断で、外から接続して試してはいない）。

<details>
<summary>根拠</summary>

- コマンド: `aws/deploy.sh`、`aws/scale.sh up`、`aws/edge-point.sh`、`aws ec2 describe-route-tables`、`describe-security-groups`、`describe-network-interfaces`（2026-11-19 23:23〜23:41）
- 結果: 経路表は、VPC の中の 2 つと `::/0 → eigw-…` だけ。IGW は VPC に付いたまま（VPC origin の条件）。ENI は `InterfaceType: cloudfront_managed`、`Description: CloudFront configured ENI`。応答は `"listener":"app"`（`/edge-point`）と `"listener":"login"`（`/login/edge-point`）、`"remote":"::ffff:54.239.215.205"`。
- 資料: [Restrict access with VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)（VPC に IGW が要る。東京は apne1-az3 を除く。この検証のサブネットは apne1-az4 と apne1-az1）、[Egress-only internet gateways](https://docs.aws.amazon.com/vpc/latest/userguide/egress-only-internet-gateway.html)（ゲートウェイの料金はない。外から始まる IPv6 の接続を通さない）。どちらも 2026-11-19 に読んだ。

</details>

### 4-9. CloudFront は、ディストリビューションが使っている VPC origin の更新を拒んだ。VPC origin を 2 組持って切り替えると、向け直しは 3〜6 分だった
**結論:** インスタンスを入れ替えたあと、VPC origin の送り先（インスタンスの ARN）を CloudFormation で書き換えた。CloudFront は 409 で拒み、スタックは巻き戻った。CloudFormation の型の説明は、この更新を「中断なし」としているが、当たらなかった。資料の手順（ディストリビューションから外してから更新する）のほうが正しかった。そこで VPC origin を A と B の 2 組持ち、使っていない組を新しいインスタンスに向けてから、同じスタックの更新でディストリビューションを切り替える形にした。この形で 2 回向け直し、どちらも届いた。

| 回 | 中身 | 書き換えを求めてから届くまで |
|---|---|---|
| 最初の作り | VPC origin を新しく作り、ディストリビューションの送り先にする | 596 秒 |
| 1 回目の向け直し | 新しい B の組を作り、ディストリビューションを B に切り替える | 192 秒 |
| 2 回目の向け直し | ディストリビューションから外れた A の組を書き換え、ディストリビューションを A に切り替える | 348 秒 |

ほとんどが、VPC origin が `Deployed` になるまで（約 8 分、約 2 分、約 2.5 分）と、ディストリビューションの切り替え（約 25 秒〜約 2.5 分）の時間だった。sslip.io の名前を書き換える方法（4-2、約 100 秒）より長い。向け直しの間は、前の組が前のインスタンスを指したままなので、インスタンスを入れ替えたときは、向け直しが終わるまで届かない。

<details>
<summary>根拠</summary>

- コマンド: `aws/scale.sh down`、`aws/scale.sh up`、`aws/edge-point.sh`（2026-11-19 23:47〜2026-11-20 00:09）。2 回目は、edge-check のタスクを、配置制約でもう 1 台へ移してから行った。
- 拒まれたときの理由: `The specified VPC origin is currently associated with one or more distributions. Please disassociate the VPC origin from all distributions before updating or deleting (Service: CloudFront, Status Code: 409 …)`
- 結果: `edge-point.sh` の出力で、スタックの更新 551 秒・188 秒・343 秒、届くまで 596 秒・192 秒・348 秒。

</details>

### 4-10. ディストリビューションの既定のドメインを RP ID にして、パスキーを登録し、別のパスのエンドポイントで文書のハッシュに署名できた。cloudfront.net は RP ID にできなかった
**結論:** ディストリビューションの既定のドメイン（`dXXXX.cloudfront.net`）を RP ID にして、ログインサーバーの役のエンドポイント（`/login/`）でパスキーを登録できた。同じ資格情報で、顧客のアプリの役のエンドポイント（`/app/`）から、文書の SHA-256 を challenge にして署名できた。サーバーの検証（`@simplewebauthn/server` 13.3.3）は、どちらも RP ID のハッシュ、origin、ユーザーの確認、署名を通した。署名された clientDataJSON の challenge は、文書のハッシュと一致した。RP ID を `cloudfront.net` にして登録を求めると、ブラウザーが `SecurityError` で拒んだ。`cloudfront.net` は Public Suffix List にあるので、別のディストリビューションが同じ RP ID を名乗ることはできない。

試しの署名の challenge は、毎回同じ文書のハッシュにした。そのため、同じ署名を出し直されても見分けられない。段 D で署名するハッシュには、申込みごとに変わる値（案や時刻）が入るので、この問題は起きない見込み（推定）。

<details>
<summary>根拠</summary>

- 試した環境: Windows の Microsoft Edge、認証器は Windows Hello（持ち主が操作した。2026-11-19 23:45〜23:47）。
- 結果: 登録は `verified: true`、`device_type: singleDevice`、`backed_up: false`、`user_verified: true`。署名は `verified: true`、`challenge_is_document_hash: true`、`new_counter: 1`。サーバーのログの `passkey_registered` と `passkey_signed` も同じ値。
- `cloudfront.net` のとき: `SecurityError: The relying party ID is not a registrable domain suffix of, nor equal to the current domain. Subsequently, an attempt to fetch the .well-known/webauthn resource of the claimed RP ID failed.` Edge は、拒む前に、別の名前を許す仕組み（Related Origin Requests）のファイルを取りに行っていた。

</details>
### 4-11. t4g.medium 1 台に Keycloak と認可サーバーが載り、インスタンスが 0 の状態から約 6〜7 分で使えた。いちばん長いのは VPC origin の向け直しだった
**結論:** 段 C の C-3 を 3 回測り、3 回とも予測（インスタンスを起動してから使えるまで 10 分以内）の内に収まった。終点は 369 秒、370 秒、402 秒。測り方の定義は [log.md の 2026-11-20 の決定](log.md#決めたこと) のとおりで、VPC origin の向け直しを含む。全部のサービスが t4g.medium 1 台に載り、10 分置いても、メモリの不足で止まったタスクは 0 件だった。

時間の内訳では、向け直し（約 3〜4 分）がいちばん長かった。インスタンスが ASG に加わるまでが約 2 分、Keycloak と auth の起動は、それぞれインスタンスの上で数十秒だった。入口を内部向けの ALB にすると、向け直しが要らなくなる（[design-decisions](design-decisions.md)）。その場合、使えるまでは約 4 分になる見込み（推定。auth の起動の約 220 秒に、ALB のターゲットの登録とヘルスチェックの時間が足される）。

メモリの最大は、Keycloak が約 530 MiB（上限 1 GiB）、auth が約 200 MiB（上限 512 MiB）だった。全部のタスクを合わせると約 1.1 GB で、t4g.small の物理のメモリには収まる値だった。ただし、今のメモリの上限（Keycloak 1 GiB、auth 512 MiB）では、t4g.small に置けない。4-14 のインスタンスで、auth が `RESOURCE:MEMORY` で置けなかった。t4g.small は試していない。リクエストを流さずに置いただけなので、負荷をかけたときのメモリは分からない。

<details>
<summary>根拠</summary>

- コマンド: `GEKKO13_INSTANCE_TYPE=t4g.medium GEKKO13_MAX_HOSTS=1 GEKKO13_CONTAINER_INSIGHTS=enabled aws/deploy.sh …`、`aws/c3-measure.sh`（2026-11-20、コミット `20e83ce` のイメージ）。1 回目のあとに 10 分置いた（30 分から縮めた。[log.md](log.md#決めたこと)）。
- 結果（始点からの秒）:

| 回 | インスタンスが ASG に加わった | Keycloak の起動（ログ） | auth の起動（ログ） | 終点 |
|---|---|---|---|---|
| 1 | 114 | 164 | 230 | 369 |
| 2 | 112 | 175 | 213 | 370 |
| 3 | 112 | 193 | 217 | 402 |

- 向け直しは、edge-check が RUNNING になった時刻（160〜168 秒）に始め、スタックの更新が 192 秒、193 秒、223 秒だった。どの回も、更新が終わってから 5 秒以内に、Keycloak の discovery がディストリビューションのドメイン名を issuer にして返った。
- メモリの最大（Container Insights の `MemoryUtilized`、1 分ごとの最大、1 回目の 10 分）: keycloak 528、auth 205、bff・transfer・ledger 各 81、edge-check 41、spire-server 20（MiB）。spire-agent（DAEMON）は測っていない。
- 止まったタスク: spire-agent が 1 件（`Essential container in task exited`）。インスタンスを起動した直後に、agent が server より先に起きて止まる既知の動き（推定。agent のログでは確かめていない）。
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

### 4-14. ECS のスタックの更新が止まる前に起きたインスタンスは、古い起動テンプレートのまま残った
**結論:** `aws/deploy.sh` は、ECS のスタックを更新する前に、spire-server のタスク数を 1 に戻す（2-9 の対策）。4-12 で更新が送られずに止まったときも、タスク数は 1 になったので、キャパシティプロバイダーが古い起動テンプレート（t4g.small）でインスタンスを起動した。そのあと更新が通っても、起きていたインスタンスは t4g.small のままで、上限 1 台の下で auth が `RESOURCE:MEMORY` で置けず、スタックの更新が待ち続けた。インスタンスを 0 にすると、更新は終わった。起動テンプレートを変える更新のあとは、インスタンスを 0 にしてから再起動す。

<details>
<summary>根拠</summary>

- 2026-11-20。ECS のサービスのイベント: `was unable to place a task. Reason: TaskFailedToStart: RESOURCE:MEMORY`。インスタンスの登録メモリは 1,846 MiB、残りは 182 MiB だった。
- `aws/scale.sh down` のあと、`Successfully created/updated stack - gekko13-ecs`。

</details>
## 5. 段 D
### 5-1. 入口を内部向けの ALB にすると、インスタンスが 0 の状態から約 3 分で使え、2 つの AZ のどちらのインスタンスにも届いた
**結論:** 段 D の D0 を 3 回測り、3 回とも予測（300 秒以内）に収まった。終点は 193 秒、178 秒、166 秒で、C-3（369〜402 秒、[4-11](#4-11-t4gmedium-1-台に-keycloak-と認可サーバーが載りインスタンスが-0-の状態から約-67-分で使えたいちばん長いのは-vpc-origin-の向け直しだった)）の半分ほどになった。VPC origin の向け直しがなくなったためである。どの回も、CloudFront を通した edge-check の応答に、2 つの AZ（ap-northeast-1a と ap-northeast-1c）が現れた。

最後に待ったのは、3 回とも auth の起動だった。auth は、SPIRE server が動き、SVID が書かれてから起動するので、server の起動を待つ分だけ遅れる（推定）。Keycloak は、ALB が HEALTHY と判定するより前に、CloudFront から応えることがあった。ALB は、正常なターゲットが 1 つもないとき、全部のターゲットに送る（fail open）ためとみられる（推定）。

<details>
<summary>根拠</summary>

- コマンド: `GEKKO13_AZS=2 GEKKO13_INSTANCE_TYPE=t4g.medium GEKKO13_MAX_HOSTS=2 aws/deploy.sh`、`aws/d0-measure.sh`（2026-11-20〜21、コミット `9637703`）。測り方の定義は [log.md](log.md#決めたこと) の 2026-11-21 の決定。
- 結果（始点からの秒）:

| 回 | インスタンスが ASG に加わった | Keycloak が応えた | 2 つめの AZ が応えた | 終点（auth の起動） |
|---|---|---|---|---|
| 1 | 109 | 182 | 183 | 193 |
| 2 | 89 | 162 | 153 | 178 |
| 3 | 70 | 155 | 125 | 166 |

- 0 台から起動すると、どの回も 2 台が同じ時刻に ASG に加わった。edge-check の 2 タスクを別のインスタンスに置く制約（distinctInstance）で、2 台が要ると見積もられたとみられる（推定）。
- 1 回目は、Keycloak が CloudFront から応えたのが 182 秒で、ALB のターゲットが HEALTHY になったのは 202 秒だった（`describe-target-health`）。
- ECS が RUNNING を返す時刻は、CloudFront から応えた時刻より遅いことがあった（4-11 と同じ）。
- デプロイのあとの確かめで、`/edge-point` を 8 回呼ぶと、2 つの AZ に 4 回ずつ届いた。

</details>

### 5-2. ALB を指す VPC origin を作るのに約 9 分、ディストリビューションの切り替えに約 1 分、古い VPC origin を消すのに約 7 分かかった
**結論:** 入口を、インスタンスを指す VPC origin の 4 つ（A と B の組）から、ALB を指す VPC origin 1 つに作り替えた。1 回のスタックの更新で、CloudFormation は新しい VPC origin を作り、ディストリビューションを切り替え、古い 4 つを並べて消した。切り替えの間も、ディストリビューションのドメイン名（RP ID）は変わらなかった。VPC origin を作るのと消すのは、どちらも数分かかるので、ALB は作り直さない（[design-decisions](design-decisions.md)）。

<details>
<summary>根拠</summary>

- スタック `gekko13-edge` の出来事（2026-11-20、UTC）: `AlbVpcOrigin` の作成 15:27:18〜15:36:30、`Distribution` の更新 15:36:32〜15:37:37、古い 4 つの削除 15:37:39〜15:44:48。
- 切り替えのあとも、`DomainName` は前と同じだった。

</details>

### 5-3. 入口のリバースプロキシ（Web Functions）は、NetworkConnector の先から名前空間の SRV を引き、2 つの AZ のタスクに届いた。本文付きの POST と複数の Set-Cookie が通り、エンドポイントを直接呼ぶと 403 だった
**結論:** CloudFront から、OAC で署名して Web Functions のリバースプロキシを呼んだ。リバースプロキシは、名前空間 `svc.gekko13.internal` の SRV を VPC の DNS で引いて、タスクへ送った。Lambda の資料は、VPC に関連づけたプライベートのホストゾーンが引けるとだけ書き、Cloud Map の名前空間には触れていない。実際には、Cloud Map の名前空間の SRV も引けた。

| 確かめたこと | 結果 |
|---|---|
| `/edge-point` を 6 回 | 6 回とも 200。AZ は 2 種類（1a が 4 回、1c が 2 回） |
| Keycloak の discovery | 200。issuer はディストリビューションのドメイン名 |
| Keycloak のトークンのエンドポイントへのフォームの POST（知らない client） | 401 の `invalid_client`。本文の `client_id` が Keycloak に届いた |
| Keycloak の認可の画面 | 200。Set-Cookie が 3 つとも、属性（Path、HttpOnly、SameSite）ごと届いた |
| リバースプロキシのエンドポイントを、署名なしで直接 | 403 |

リバースプロキシの記録では、11 件のリクエストがすべて 1 回めの送り先で通り、リトライもエラーも 0 件だった。リバースプロキシの中の時間は 2〜34 ms、Keycloak の最初の認可のリクエストだけが 149 ms だった。実行環境の起動は 340 ms、メモリは 141 MB だった。

<details>
<summary>根拠</summary>

- コマンド: `curl https://<配信の名前>/edge-point`（6 回）、`curl` で discovery、トークンのエンドポイント（`grant_type=client_credentials`）、認可のエンドポイント（`client_id=gekko13-app`、PKCE つき）、エンドポイントの名前への直接の `curl`（2026-11-21 05:46〜05:50 UTC）。
- リバースプロキシの記録: `/aws/lambda/web/gekko13-entry` の `proxied` の行の `ms` と `attempt`、`platform.initReport` の `totalDurationMs` と `maxMemoryUsageMb`。
- 実行環境の版: `nodejs24.x:nodejs.web24.v22`。zip の中は、`scripts/stage-entry.sh` が TypeScript から変えた JavaScript（コミット `f76be6a`）。

</details>

### 5-4. NetworkConnector の操作ロールと Web Functions の実行ロールは、信頼ポリシーに aws:SourceAccount の条件があると、Lambda に引き受けられなかった
**結論:** どちらのロールも、主体を `lambda.amazonaws.com` にし、`aws:SourceAccount` を自分のアカウントに限る条件を付けた。NetworkConnector の作成は「The service is unable to assume the provided NetworkConnectorOperatorRole」で拒まれた。条件を外して作り直すと、NetworkConnector は通った。次に、リビジョンの作成が「The execution role ... cannot be assumed by lambda.amazonaws.com」で拒まれ、こちらも条件を外すと通った。Lambda の資料の操作ロールの信頼ポリシーにも、gekko_10 の実行ロールにも、条件はない。EC2 のロール（`ec2.amazonaws.com`）では、同じ条件で問題なく動いている。 <!-- check-docs: 残す エラーの文言をそのまま引くため -->

<details>
<summary>根拠</summary>

- スタック `gekko13-entry` の出来事（2026-11-21、UTC）: `Connector` の CREATE_FAILED（04:55:30）、`Revision` の CREATE_FAILED（05:21:36）。直したコミットは `3572866` と `0078b45`。
- 資料: https://docs.aws.amazon.com/lambda/latest/dg/web-functions-networking.html の「Operator role permissions」（2026-11-21 に読んだ）。

</details>

### 5-5. CloudFront は、Web Functions の送り先の OAC に、署名の仕方 always を拒み、always-amz-auth を求めた
**結論:** OAC の `SigningBehavior` を `always` にすると、ディストリビューションの更新が「Lambda-Web origins require always-amz-auth signing behavior」で拒まれ、ディストリビューションのスタックは前の状態に巻き戻った。CloudFormation の型は、`never`、`no-override`、`always`、`always-amz-auth` のどれも受け付けるので、型の検査では見つからない。Lambda の資料と gekko_12 の実測 3-8 は、`always-amz-auth` と書いている。 <!-- check-docs: 残す エラーの文言をそのまま引くため -->

<details>
<summary>根拠</summary>

- スタック `gekko13-edge` の出来事（2026-11-21 05:41 UTC）: `Distribution` の UPDATE_FAILED。直したコミットは `f36f273`。

</details>

### 5-6. NetworkConnector を作るのに約 4 分、リバースプロキシのリビジョンとエンドポイントは十数秒、ディストリビューションの切り替えに約 3 分かかった
**結論:** 入口のリバースプロキシのスタックは、作り始めから約 5 分でできた。ほとんどが NetworkConnector（ENI を 2 つの AZ に作る）の時間だった。リビジョンは約 4 秒、エンドポイントは約 8 秒だった。止めてあったディストリビューションを、送り先をリバースプロキシに替えて有効にするのに約 3 分かかった。どれも、作るときに一度だけかかる時間で、使わない間は消さないので、戻すときにはかからない。巻き戻しで NetworkConnector を消すのには、約 2 分かかった。

<details>
<summary>根拠</summary>

- スタック `gekko13-entry` の出来事（2026-11-21、UTC）: `Connector` 05:36:13〜05:40:29、`Revision` 05:40:31〜05:40:35、`Endpoint` 05:40:36〜05:40:44。
- スタック `gekko13-edge` の出来事: `Distribution` 05:42:21〜05:45:27。
- 巻き戻し: `Connector` の DELETE_COMPLETE は 04:57:47（CREATE_FAILED の約 2 分後）。

</details>

### 5-7. 入口を Web Functions のリバースプロキシにしても、インスタンスが 0 の状態から約 3〜4 分で使え、2 つの AZ のどちらのインスタンスにも届いた。インスタンスが 0 の間、ディストリビューションは 503 を返した
**結論:** D0-b の「インスタンスが 0 から使えるまで」を、D0 と同じ定義で 3 回測った。終点は 220 秒、246 秒、184 秒で、3 回とも 300 秒以内、毎回 2 つの AZ が現れた。plan.md の予測（約 4 分）どおりだった。ばらつきの多くは、インスタンスが ASG に加わるまでの時間（75〜152 秒）だった。edge-check は、RUNNING になってから 2〜3 秒で、CloudFront から届いた。ALB の D0（166〜193 秒。[5-1](#5-1-入口を内部向けの-alb-にするとインスタンスが-0-の状態から約-3-分で使え2-つの-az-のどちらのインスタンスにも届いた)）と比べて、入口による遅れは見えなかった。

インスタンスを 0 にしている間も、ディストリビューションは有効なまま、リバースプロキシが 503 の `no target` を返した。測定の間のリバースプロキシの記録は、次のとおりである。

| 数えたもの | 件数 |
|---|---|
| `no target`（503） | 292（インスタンスが 0 の間と、タスクが登録される前） |
| 送り先へ転送したリクエスト | 85（すべて 1 回めの送り先で通った） |
| 送り先につながらなかったリクエスト（502） | 0 |

リバースプロキシの中の時間は、中央値 5 ms、最大 179 ms だった。実行環境は、20 分の間に 1 回だけ起き（330 ms）、そのまま使われ続けた。

<details>
<summary>根拠</summary>

- コマンド: `aws/scale.sh down` と `aws/d0-measure.sh` を 3 回（2026-11-21 05:53〜06:14 UTC、コミット `69f8f61`）。結果は `local/run/d0/20261121T055522Z`、`20261121T060300Z`、`20261121T061100Z` の `result.md`。
- 内訳（始点からの秒。1 回目、2 回目、3 回目）: インスタンスが ASG に加わった 128、152、75。edge-check が RUNNING 178、203、140。CloudFront を通して Keycloak が応えた 220、236、152。auth の起動（ログの時刻）は、3 回目が 184 で終点を決めた。
- リバースプロキシの記録: `/aws/lambda/web/gekko13-entry` の `no-target`、`proxied`、`upstream-failed` の行を数えた（05:53 UTC 以降）。

</details>

### 5-8. 名前空間の DNS は、全部のタスクが UNHEALTHY のとき、UNHEALTHY のタスクも返した
**結論:** 3 回目の測定の間、3〜5 秒ごとに 3 つを記録した。edge-check の 2 つのタスクのヘルスステータス、正常なインスタンスだけを返す API（`discover-instances`）の件数、CloudFront を通した `/edge-point` の状態である。ECS は、タスクをはじめ UNHEALTHY として登録した。2 つとも UNHEALTHY の間、`discover-instances` は 0 件を返したが、CloudFront を通すと 200 が返った。リバースプロキシが引く DNS は、UNHEALTHY のタスクも返したことになる。1 つが HEALTHY になると、`discover-instances` も 1 件になった。

Route 53 の複数値の答えが、全部が正常でないときに全部を返す動きと合う（推定）。全部が HEALTHY になったあとで、DNS が UNHEALTHY のタスクを外すかは確かめていない。影響として、タスクが起きかけの間は、ヘルスチェックを通る前のタスクにもリクエストが届く。待ち受けの前なら、リバースプロキシはリトライ、それでもつながらなければ 502 を返す。この測定では 502 は 0 件だった。タスクが 1 つしかないサービスでは、正常でなくなったタスクにも送り続ける。

<details>
<summary>根拠</summary>

- 記録（2026-11-21、UTC）: 06:13:18 に 2 つとも UNHEALTHY、`discover-instances` は 0、CloudFront は 503。06:13:23 に 2 つとも UNHEALTHY のまま、CloudFront は 200。06:14:06 に 1 つが HEALTHY、`discover-instances` は 1。06:14:16 に 2 つとも HEALTHY、`discover-instances` は 2。
- コマンド: `aws servicediscovery get-instances-health-status`、`aws servicediscovery discover-instances`、`curl https://<配信の名前>/edge-point` を、3 秒の間を置いて繰り返した。

</details>

### 5-9. インスタンスを全部スポットにしても、2 つの AZ にインスタンスが起き、インスタンスが 0 の状態から約 3 分半で使えた。1a では t4g.large が選ばれた
**結論:** ASG を、オンデマンドを 0 台にし、4 つの種類（t4g.medium、c6g.large、c7g.large、t4g.large）を `price-capacity-optimized` で選ぶ形にした。インスタンスは 2 回起動し、2 回とも 2 台ともスポットで起きた。1c は t4g.medium、1a は t4g.large だった。1a では、t4g.medium より高い t4g.large が選ばれたことになる。空きの多さを優先したと見られる（推定）。D0-b の測り方で 1 回測ると、終点は 204 秒で、2 つの AZ が現れた。オンデマンドの 3 回（184〜246 秒。[5-7](#5-7-入口を-web-functions-のリバースプロキシにしてもインスタンスが-0-の状態から約-34-分で使え2-つの-az-のどちらのインスタンスにも届いたインスタンスが-0-の間ディストリビューションは-503-を返した)）の幅に収まった。中断は、この間には起きなかった。

<details>
<summary>根拠</summary>

- コマンド: `aws/deploy.sh`（コミット `e820719`）、`aws ec2 describe-instances` の `InstanceType`、`InstanceLifecycle`、`Placement.AvailabilityZone`、`aws/scale.sh down`、`aws/d0-measure.sh`（2026-11-21 06:39〜07:00 UTC）。結果は `local/run/d0/20261121T065325Z/result.md`。
- 内訳（始点からの秒）: インスタンスが ASG に加わった 120、edge-check と keycloak が RUNNING 182、CloudFront を通して 2 つの AZ の edge-check が応えた 194、Keycloak が応えた 204、auth の起動（ログの時刻）204。
- スポットの価格（東京、2026-11-21、1 時間あたり）: t4g.medium は 1a 0.0170 ドル、1c 0.0188 ドル。t4g.large は 1a 0.0327 ドル、1c 0.0300 ドル（`aws ec2 describe-spot-price-history`）。

</details>

### 5-10. Aurora の管理者は superuser でなく、ロールへ切り替える権利（SET）がないと、そのロールを持ち主にしたデータベースを作れなかった
**結論:** db-init の `CREATE DATABASE spire OWNER spire` が、Aurora で `must be able to SET ROLE "spire"` に拒まれた。PostgreSQL 16 からは、データベースの持ち主を別のロールにするには、作る側がそのロールに切り替えられる必要がある。ロールを作った者は管理の権利（ADMIN）を持つが、切り替える権利（SET）は持たない。手元の PostgreSQL の管理者は本物の superuser なので、この制限にかからず、手元の確かめでは見つからなかった。管理者に `GRANT spire TO <管理者> WITH SET TRUE` を与えてから作ると通った。手元でも、superuser でない管理者（CREATEROLE と CREATEDB だけ）で、同じ誤りと直りを確かめた。

<details>
<summary>根拠</summary>

- db-init のログ（2026-11-21 08:3x UTC）: `psql:/db-init.sql:35: ERROR:  must be able to SET ROLE "spire"`。直したコミットは `3847343`。
- 手元: `postgres:17` に `CREATE ROLE admin2 LOGIN CREATEROLE CREATEDB` を作り、その管理者で流した。直す前は同じ誤り、直したあとは 2 つ同時でも通った。
- 一度だけのタスク（`gekko13-dbfix:1`）で、直した SQL を Aurora に流し、そのとき動いていた更新を通した。

</details>

### 5-11. 2 つの SPIRE server が、空のデータベースに同時にスキーマを作ると、片方がぶつかって止まった。ECS が再起動したあとは通った
**結論:** SPIRE server の 2 タスクが、空の `spire` のデータベースに同時に起動した。片方は `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` で止まった。スキーマを作る処理（表の作成）が、同時に走ってぶつかったと見られる（推定）。もう片方がスキーマを作り終えたあと、ECS が再起動したタスクは通った。データベースが空のときに、一度だけ起きる。

<details>
<summary>根拠</summary>

- spire-server のログ（2026-11-21 10:29 UTC）: `Fatal run error ... pq: duplicate key value violates unique constraint "pg_type_typname_nsp_index" (23505)`。
- その前に動いたもう 1 つのタスクは、登録を作り、バンドルを書き、agent の SVID を更新していた。

</details>

### 5-12. Keycloak の 2 タスクは、ログインの画面を作ったタスクを止めても、もう片方がセッションを引き継いだ（CloudFront を通して）
**結論:** CloudFront を通してログインの画面を開き、セッションの Cookie を受け取った。Cookie の `AUTH_SESSION_ID` の末尾のノードの名前から、画面を作ったタスクを特定し、そのタスクだけを止めた。止めたあと、同じ Cookie で違うパスワードを送ると、200 で「Invalid username or password」が返った。Cookie を付けないと、400 で「cookie not found」だった。もう片方の Keycloak が、JGroups で共有したセッションを引き継いだ。plan.md の D1-a1 の予測 3 のとおり。

<details>
<summary>根拠</summary>

- 2026-11-21 11:29〜11:30 UTC。セッションのノード `ip-10-13-1-104-19348` は、タスク `450d33ca…` の起動のログの `Node name` と一致した。`aws ecs stop-task` で止め、STOPPED を確かめてから送った。
- 手元でも、2 つのコンテナで同じ結果だった。

</details>

### 5-13. SPIRE server の片方が止まっても、残った server が、新しいタスクに SVID を出した
**結論:** インスタンスを止める試し（5-14）で、SPIRE server の片方と auth の片方が、一緒に止まった。代わりの auth は、止めてから 24 秒で残ったインスタンスに作られ、68 秒で SVID を受け取った。代わりの SPIRE server は、配置制約（1 台に 1 つ）のため、代わりのインスタンスを待って 85 秒で作られ、172 秒で待ち受けを始めた。代わりの auth の SVID は、残った 1 つの server が出したことになる。plan.md の D1-a1 の予測 4 のとおり。

<details>
<summary>根拠</summary>

- 2026-11-21 11:34:15 UTC に止めた。時刻は、ECS のタスクの `createdAt`、svid-helper のログの `X.509 certificates updated`、spire-server のログの `Starting Server APIs` から取った。
- その前の試し（SPIRE server と auth を同時に止めた）では、代わりの server が先に起動したので、この判定には使わない。その間も、agent は、残った server で SVID を更新し続けた。

</details>

### 5-14. インスタンスを 1 台、予告なしに止めても、入口のリクエストの失敗は 418 回のうち 1 回だった。代わりの auth は残ったインスタンスに置かれ、AZ が偏った
**結論:** 1c のインスタンス（spire-server、Keycloak、auth、edge-check が 1 つずつ載っていた）を、`terminate-instances` で予告なしに止めた。止めてから 8 分のあいだ、2 秒ごとに CloudFront を通して `/edge-point` と Keycloak の discovery を呼んだ。失敗は、止めてから 4 秒後の Keycloak の 1 回だけ（5 秒で応えが返らなかった）で、plan.md の D1-a1 の予測 6（1 分以内に収まる）のとおりだった。

代わりの auth は、配置制約がないので、残った 1a のインスタンスに置かれた。代わりのインスタンスが起動したあとも、auth は 2 つとも 1a に残った。ECS は、動いているタスクを自分では並べ直さない。AZ の偏りの直し（`AvailabilityZoneRebalancing`）は無効で、しかも `MaximumPercent` が 100 % だと効かない（ECS の資料）。

<details>
<summary>根拠</summary>

- コマンド: `aws/failover-check.sh`（2026-11-21 11:33:50〜11:42 UTC）。結果は `local/run/failover/20261121T113350Z/result.md`。
- 呼んだ数は `/edge-point` と discovery が 209 回ずつ。失敗は discovery の 1 回（状態 000）。
- 資料: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-rebalancing.html （2026-11-21 に読んだ）。

</details>

### 5-15. auth の 2 タスクは、同じ署名鍵（同じ鍵の ID）を持った
**結論:** auth が起動するときに、署名鍵の ID（公開鍵のサムプリント）をログに出すようにした。2 つのタスクのログは、どちらも `shared=true` で、鍵の ID が同じだった。片方が出したトークンを、もう片方が確かめられる鍵の形である。実際にトークンを出して、もう片方で確かめたのではない（D1-a2 で、BFF がトークンを交換するときに確かめる）。plan.md の D1-a1 の予測 5 は、鍵の形までを確かめた。

<details>
<summary>根拠</summary>

- auth のログの `signing key: shared=true, kid=...`（2026-11-21 12:2x UTC、コミット `4d80532`）。2 つのタスクの kid が一致した。

</details>

### 5-16. AZ の偏りの直しを有効にすると、偏ったタスクを ECS が並べ直した。`MaximumPercent` を 200 % にすると、ローリングアップデートの間にインスタンスが 1 台増えた
**結論:** 4 つのサービスで `AvailabilityZoneRebalancing` を有効にし、`MaximumPercent` を 200 % にした。デプロイのあと 1 つの AZ に偏った edge-check を、ECS は、もう一方の AZ に新しいタスクを起動してから古いタスクを止める形で、並べ直した。並べ直しの間も、タスクは 2 つ以上動いていた。偏りを見つけるまでには、サービスが安定してから 15 分ほどかかった。その間に偏った側の AZ が止まると、そのサービスは止まる。

`MaximumPercent` を 200 % にしたので、ECS は、古いタスクを止める前に、新しいタスクを 1 つ多く起動しようとした。配置制約が 1 台に 1 つの spire-server は、2 台では置けず、キャパシティプロバイダーがインスタンスを 3 台目まで増やした。止まらずに更新できる代わりに、更新の間の時間と費用が少し増える。

<details>
<summary>根拠</summary>

- edge-check のサービスの記録（2026-11-21、日本時間）: 21:29:13 `has reached a steady state`、21:44:42 `is not AZ balanced with 2 tasks in ap-northeast-1a, 0 tasks in ap-northeast-1c. AZ Rebalancing in progress.`、21:44:42 `has started 1 tasks in ap-northeast-1c to AZ Rebalance`、21:45:21 `has stopped 1 running tasks in ap-northeast-1a due to AZ Rebalancing`、21:45:32 `stopped AZ Rebalancing.`
- インスタンスの数: `aws autoscaling describe-auto-scaling-groups` で、spire-server のローリングアップデートの間に 2 台から 3 台になった（コミット `4d80532` のデプロイ）。
- 資料: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-rebalancing-event-messages-list.html （2026-11-21 に読んだ）。似た例として、Classmethod の記事（https://dev.classmethod.jp/articles/amazon-ecs-az-rebalancing-speeds-mean-time-recovery-event ）は、Fargate で「初回デプロイから 15 分後ほど」に並べ直したと書いている。

</details>

### 5-17. Aurora と冗長化を足しても、インスタンスが 0 の状態から約 3 分半〜4 分で使えた。Aurora は、つながりがなくなって 5 分ほどで一時停止し、再開は 5 秒ほどだった
**結論:** D1-a1 の作り（Aurora、SPIRE server と Keycloak と auth の 2 タスク）で、3 回測った。1 回ごとに、インスタンスを 0 にし、Aurora が 0 ACU になるのを待ってから、D0-b と同じ定義で測った。終点は 228 秒、234 秒、210 秒で、3 回とも 300 秒以内、毎回 2 つの AZ が現れた。plan.md の D1-a1 の予測 2 のとおりだった。終点を決めたのは、3 回とも auth の起動だった。D0-b（184〜246 秒。[5-7](#5-7-入口を-web-functions-のリバースプロキシにしてもインスタンスが-0-の状態から約-34-分で使え2-つの-az-のどちらのインスタンスにも届いたインスタンスが-0-の間ディストリビューションは-503-を返した)）と比べて、ほとんど延びなかった。

Aurora は、インスタンスが 0 になってから 220〜307 秒で 0 ACU になった。タスクはインスタンスより先に止まるので、最後のつながりが切れてから 5 分ほどと見られ、予測 1 のとおりだった。再開は、db-init の待ちが 0〜1 回（1 回 5 秒）で通り、予測の約 15 秒より短かった。

<details>
<summary>根拠</summary>

- コマンド: `aws/scale.sh down`、CloudWatch の `ServerlessDatabaseCapacity`（1 分ごとの最小値）が 0 になるまで待つ、`aws/d0-measure.sh`（2026-11-21 12:46〜13:24 UTC、コミット `4d80532` の作り）。結果は `local/run/d0/20261121T125427Z`、`20261121T130611Z`、`20261121T131739Z` の `result.md`。
- 内訳（始点からの秒。1 回目、2 回目、3 回目）: インスタンスが ASG に加わった 117、134、106。CloudFront を通して Keycloak が応えた 200、206、186。auth の起動（ログの時刻）228、234、210。
- db-init のログ: 1 回目は 2 つとも 1 回待って +191 秒で終わった。2 回目は片方が 1 回待った。3 回目は 2 つとも待たずに +180 秒で終わった。

</details>

### 5-18. 認可の記録をデータベースに置くと、`java.lang.Long` の値を含む記録は読み戻せなかった
**結論:** Spring Authorization Server の認可の記録は JSON で保存され、読み戻すときに Jackson の許可の一覧で型を確かめる。取決めの範囲の上限（`maxBenefit`）を `Long` で入れた記録は、一覧にないとして拒まれ、交換が失敗した。`List.of` と `Map.of` の型も一覧にない（D1-a1 で分かっていた）。auth は、記録に入れる値を `ArrayList`、`LinkedHashMap`、`Integer` に写してから入れる（`services/auth` の `Plain`）。

<details>
<summary>根拠</summary>

- auth の単体の試験を、メモリの H2（PostgreSQL の互換の形）に書いて読み戻す形にして回した（2026-11-21）。`The class with java.lang.Long ... is not in the allowlist`（参照の道は `authorization_details[0].maxBenefit`）で 9 件が失敗し、写す処理を足すと全部通った。

</details>

### 5-19. Keycloak 26.8.2 の管理の API は、トークンにクライアントスコープ `kc-admin-api` の宛先を求めた。スコープは、レルムの JSON に定義しないと、取り込みで割り当てられなかった
**結論:** 認可サーバーは、JWT-SVID でクライアント認証して、Keycloak の管理の API で利用者の passkey を読む（gekko_11 の D-42）。26.8.2 では、gekko_11（26.8.1）と同じ設定のトークンが 401 になった。クライアントに `kc-admin-api` を既定のスコープとして割り当てると通る。このスコープはレルムを作るときに自動で足されるが、取り込むレルムの JSON の `defaultClientScopes` に名前だけ書いても、取り込みの時点ではまだなく、割り当てが落ちた。スコープそのものを JSON に定義すると、割り当てられた。

<details>
<summary>根拠</summary>

- Keycloak のログ（管理の API の部分を debug にした）: `Failed to verify identity token: Expected audience not available in the token`（2026-11-21、手元）。
- Keycloak 26.8.2 の upgrading の資料: 管理の API のトークンには、宛先と `kc-admin-api` のスコープが要る（https://www.keycloak.org/docs/26.8.2/upgrading/ 、2026-11-21 に読んだ）。
- 割り当ての有無は、データベースの `client_scope_client` で見た。名前だけのときは `basic` だけだった。

</details>

### 5-20. CloudFront とリバースプロキシの後ろの Keycloak は、DPoP の `htu` を、届いた要求の URL（http と、CloudFront が替えた Host）で照らし、認可コードの交換を断った
**結論:** `KC_HOSTNAME` に公開の完全な URL を渡しても、DPoP の照合（`invalid_dpop_proof`、`DPoP HTTP URL mismatch`）は直らなかった。入口のリバースプロキシが公開の origin を `X-Forwarded-Proto`、`X-Forwarded-Host`、`X-Forwarded-Port` で付け、Keycloak が `KC_PROXY_HEADERS=xforwarded` で信じると、交換が通った。リバースプロキシは、閲覧者が送った同じ名前のヘッダーを捨てる。手元では、BFF が Host を公開の名前にして Keycloak を直接呼ぶので、この食い違いは出なかった。

<details>
<summary>根拠</summary>

- Keycloak のログ（2026-11-21 15:00 UTC）: `type="CODE_TO_TOKEN_ERROR" ... error="invalid_dpop_proof", reason="DPoP HTTP URL mismatch"`。同じころ `Non-secure context detected` の警告。
- 直したあと（コミット `9dc7045` のデプロイ）、`scripts/ui-login.ts` が CloudFront を通して 3 手順とも通った（15:16 UTC）。

</details>

### 5-21. `aws cloudformation deploy` は、渡さないパラメーターに前の値を使い続けた。scale.sh down が 0 にしたオートスケーリングの幅も、スタックの更新では戻らなかった
**結論:** 入口のリバースプロキシの振り分け（`Routes`）は、テンプレートの既定値を替えても、前の値（`/=edge-check`）のままで「変更なし」になった。`deploy.sh` は `Routes` を毎回明示して渡す。また、`scale.sh down` は、Application Auto Scaling の幅を 0〜0 にする。そのあとスタックの更新で Keycloak のタスクを入れ替えると、入れ替えのあとでタスク数が 0 になった（auth も同じ幅だった）。`deploy.sh` は、更新の前に幅を 2〜4 に戻す。

<details>
<summary>根拠</summary>

- 1 回目のデプロイ（2026-11-21 14:5x UTC）: `No changes to deploy. Stack gekko13-entry is up to date`。スタックの `Routes` の値は `/login=keycloak,/=edge-check` だった。
- 2 回目のデプロイのあと: `describe-scalable-targets` で keycloak と auth が `0 0`。Keycloak のイベントは「deployment completed」のあと、タスクを 2 つ止めた。入口は 503 を返した。`aws/scale.sh up` で戻った。

</details>

### 5-22. 手元で、主の流れの 2〜7 段が、Envoy なしで通った。サービスのトークンの確かめは、TypeScript、Python、Java の 3 つで、共通の例 15 件の判定が全部一致した
**結論:** 各アプリは、自分で SVID の mTLS を終え、トークンを確かめ、次の段のトークンに替える。この形で、gekko_11 の主の流れの 2〜7 段が、手元の入口から最後まで通った（4 回続けて通った）。2〜7 段は、案の提示、意向確認と申込みの署名、A→B→C の交換、検証と記録、直送、照合である。保険会社のシステム（Java）は、auth と顧客のアプリを、SVID の mTLS で呼べた。相手の SPIFFE ID は、握手の中で確かめた。これは plan.md の D1-a2 の予測 3 の手元の分で、AWS では D1-a2-2 を送ったときに確かめる。受け口は、呼んでよい相手でない SVID（403、`wrong_caller`）、トークンのない呼び出し（401、`no_token`）、偽のトークン（401、`bad_signature`）を断った。

<details>
<summary>根拠</summary>

- `node scripts/ui-flow.ts`（2026-11-22 01:44〜01:47 UTC、手元）。照合は、会話の最後と、受信箱と契約の画面の両方で `match`。
- 共通の例: `packages/token-guard/vectors/service-token.json` の 15 件を、vitest、pytest、JUnit で回し、どれも期待どおり。
- uvicorn は、相手の証明書を ASGI の scope に渡さなかった（uvicorn 0.54.0 の `protocols/http` に `tls` の拡張がない）。接続ができたときに、相手のアドレスをキーに控える形で補った（`services/insurer-mcp/insurer_mcp/tls.py`）。
- ホストが眠ったあとは、手元の SPIRE の agent が使い切った join token で立ち直れず、SVID が書かれなかった。新しい join token で agent を立て直すと戻った。spiffe-helper は、agent に届かない間、JWT-SVID を 1 分ごとに取り直した。

</details>

### 5-23. AWS でも、主の流れの 2〜7 段が CloudFront を通して通った。同時に作った Service Connect のサービスどうしは、タスクを入れ替えるまで、互いの名前を引けなかった
**結論:** D1-a2-2 を AWS に送り、CloudFront を通した `scripts/ui-flow.ts` が、4 回続けて照合の「一致」まで通った。保険会社のシステム（Java）は、auth（連絡先、有効性の問い合わせ）と顧客のアプリの直送の受け口を、SVID の mTLS で呼べた。plan.md の D1-a2 の予測 3 は、予測どおりだった。ただし、送った直後は、営業 AI エージェントが事務サービスの名前を引けなかった（`getaddrinfo ENOTFOUND insurer-mcp`）。4 つのサービスを同じスタックで同時に作ったので、各タスクが起きた時点で、相手の Service Connect の名前がまだなかったと見られる（推定）。4 つのタスクを入れ替える（`--force-new-deployment`）と、名前を引けた。

<details>
<summary>根拠</summary>

- 2026-11-22 03:38 UTC: 画面に「営業 AI エージェント（台本）が止まりました: getaddrinfo ENOTFOUND insurer-mcp」。入れ替えたあと、03:41〜03:47 UTC に alice、bob、hanako で 5 回通った。
- 途中の 3 回の失敗は、確かめのスクリプトの待ちの誤りだった（ログインサーバーの画面も同じ origin にあり、戻ったと誤って判断した）。直したあとは起きなかった。
- carol は、保険会社のシステムの顧客の一覧（gekko_11 の `Store.CUSTOMERS`）にいないので、案の提示を「利用者本人のトークンではない」で断られた。gekko_11 と同じ動き。

</details>

### 5-24. AWS でも、監査の画面で、主の流れの契約が「食い違いなし」と出た。書いた者は、ログストリームの名前で決められた。最初の作りでは、一覧の画面が入口の待ちの上限を超えた
**結論:** D1-a2-3 を AWS に送り、CloudFront を通した `scripts/ui-flow.ts` が、hanako と bob の 2 回とも、監査の画面の「食い違いなし」まで通った。監査サービス（Go）は、CloudWatch Logs の記録を、ログストリームの名前（`<ファミリーの接頭辞>/<コンテナ名>/<タスク>`）で書いた者に分け、トークンの連鎖（C→B→A）と会話の記録をつなげた。plan.md の D1-a2 の合格（監査の画面に、その契約の突き合わせが出る）を満たした。ただし、最初の作りでは、2 つの不具合を持ち主がブラウザで見つけた。

- 監査の担当がログインしたあと、一覧の画面が Bad Gateway になった。一覧は、契約ごとに何度も記録を探す。探すたびに CloudWatch Logs の `FilterLogEvents` を呼んだので、入口のリバースプロキシの待ちの上限（25 秒）を超えた。手元の docker のソケットからの読み出しは速く、起きなかった。監査の記録を、1 つの要求の間に 1 回だけまとめて読み、その中で探す形に直すと、通った。
- 末尾のスラッシュのない `/audit` を開くと、顧客のアプリへ移った。監査サービスは `/audit/` の下だけを受けていた。`/audit` を `/audit/` へ転送する形に直した。

<details>
<summary>根拠</summary>

- 2026-11-22 13:37 UTC: hanako と bob で、`8b 監査の画面で、その契約が食い違いなし`（会話の記録 14 行）と `判定` が `"ok":true`。`/audit` は 302 で `/audit/` へ転送された。
- 直しはコミット `ea5b593`。試験 `TestSnapshotReadsTheLogsOnce`（一覧の画面で、記録の読み出しが 1 回）と `TestAuditWithoutSlashGoesToTheAuditTop` を足した。
- 送る前に、flow のスタックが `InsufficientCapabilities` で止まった。監査サービスのタスクのロールを作るので、`CAPABILITY_IAM` が要った（コミット `7a4b864`）。

</details>

### 5-25. gekko_11 から写した作りは、利用者の役割を監査の画面でしか確かめず、監査の担当も顧客のアプリを使えた。Keycloak のクライアントごとの認証の流れで、役割のない利用者をログインの画面で止められた
**結論:** レルムには役割 `CUSTOMER`（顧客 5 人）と `AUDITOR`（kansa）があった。ただし、確かめていたのは監査サービスだけだった。顧客のアプリ、Keycloak の A の発行、auth の交換、営業 AI エージェント、事務サービス、保険会社のシステムは、どれも役割を見ていなかった。持ち主がブラウザで、kansa のまま顧客のアプリにログインできることに気付いた。gekko_11 も、`CUSTOMER` はレルムの JSON にあるだけで、確かめているところはなかった。

Keycloak の組み込みの部品で、ログインの画面で止める形に直した。部品は、役割の条件（`conditional-user-role`、否定）と拒否（`deny-access-authenticator`）である。顧客のアプリと監査の画面に、それぞれ別のブラウザの認証の流れを割り当てた（`authenticationFlowBindingOverrides`）。直したあとは、次のとおりになった。
- kansa が顧客のアプリでログインを押すと、Keycloak の画面に「顧客のアプリには、顧客の利用者だけがログインできます。」と出て止まった。
- hanako が監査の画面を開くと、「監査の画面には、監査の担当だけがログインできます。」と出て止まった。
- 監査の画面にすでに入っている kansa でも、同じ SSO のログインのまま止まった。

レルムの JSON に認証の流れを書いても、組み込みの流れは残った。JWT-SVID のクライアント認証、交換、管理の API を使う主の流れが通ったので、そう判断した。

この確かめは、ログインのときにだけ働く。直す前にできたセッションは、更新のトークンで A を取り直し続けられ、SSO セッションの上限（1 時間）まで続く（推定。設定から。試していない）。

<details>
<summary>根拠</summary>

- 2026-11-22 14:43 UTC: AWS で、hanako と bob で `8a 顧客は監査の画面を見られない`、`8c 監査の担当は顧客のアプリにログインできない`、`判定` が `"ok":true`。手元でも 14:31 UTC に同じく通った。
- 直しはコミット `0c824c8`。設定の値は Keycloak 26.8.2 の組み込みの部品の名前（`condUserRole`、`negate`、`denyErrorMessage`）。
- 組み込みのブラウザの認証の流れの形は、使い捨ての Keycloak 26.8.2 から `kc.sh export` で書き出して確かめた。

</details>

## 6. 未確認
- AZ がまるごと落ちたときと、server のタスクやインスタンスが突然消えたときに、server が何分で再起動するか（3-5）。移し先にインスタンスがなければ、インスタンスを起動するところから始まる。
- 0 台から起動するとき、マネージドスケーリングがなぜ 2 台と見積もるか（3-2）。
- インスタンスの IPv6 のアドレスへ、インターネットから直接つなぐと拒まれるか（4-8）。EIGW とセキュリティグループの作りから届かないと判断したが、手元から IPv6 で外に出られず、試していない。
- VPC origin が `Deployed` になるまでの時間のばらつき（4-9 では約 2〜8 分）。回数が 3 回と少ない。
- あるインスタンスで、IPv6 で公開したポートが拒まれた原因（4-3）。VPC origin に替えてからの 3 回の向け直しでは、起きなかった。
- ECS 用の AMI のルートの容量が 30 GB で足りるか、小さくできるか。
- t4g.small に、メモリの上限を下げて全部が載るか（4-11）。物理のメモリには収まる値だったが、試していない。
- リクエストを流したときの、Keycloak と auth のメモリ（4-11 は、置いただけの値）。段 D でシナリオを流すときに見る。
