# 基盤の動かし方と後片付け

**この文書の読み手:** この検証の基盤（ECS on EC2、SPIRE、IPv6 だけの AWS）を自分で動かす開発者。作って、インスタンスを起動し、0 にし、片付けるまでを扱う。アプリとシナリオの動かし方は、段 D の D1 で足す。何を確かめるかは [plan.md](plan.md)、判断の理由は [design-decisions.md](design-decisions.md)、用語は [用語集](glossary.md)。

## 要旨
- AWS は `aws/deploy.sh` で作り、`aws/scale.sh up` でインスタンスを起動し、`aws/scale.sh down` でタスクとインスタンスを 0 にする。
- 使わない間も、スタックは消さない。インスタンスとタスクを 0 にすれば、残る固定費はホストゾーンとアラームの月 1 ドル未満と、保存の費用だけになる（[使わない間の費用](#使わない間の費用)）。
- インスタンスはプライベートのサブネットに置き、外からは CloudFront から入口のリバースプロキシ（Lambda の Web Functions）を通してだけ届く。インスタンスが入れ替わっても、向け直しは要らない。
- 今の AWS の作りは、keycloak、auth、確かめのエンドポイント（edge-check）の 3 つのサービス。第 2 部のアプリは、段 D の D1 で載せる。

## 実行前の約束
- AWS に資源を作る前に、持ち主に確かめる。費用は [AWS の費用の見込み](#aws-の費用の見込み) のとおり。
- スタックの削除などの戻しにくい操作は、先に対象を一覧で見せて、承認を得る。
- 秘密、トークン、アカウント ID を、画面の出力やファイルに残さない。手順のスクリプトは、どれも出さないように書いてある。

## 前提
- Node.js 24 以上、docker（buildx を含む）、openssl。`docker compose` は要らない。
- AWS の段では、AWS CLI v2 も要る。
- AWS の段では、東京リージョン（ap-northeast-1）で、次の資源を作れる権限が要る。
  - 基盤: CloudFormation、IAM、EC2、Auto Scaling、ECS、ECR
  - 保存と発見: EFS、Aurora（RDS）、Cloud Map、Route 53（Cloud Map が作るホストゾーン）、Application Auto Scaling
  - 入口: Lambda（Web Functions と NetworkConnector）、S3（リバースプロキシの zip）、CloudFront
  - 記録と秘密: SSM、CloudWatch Logs
- 依存は `npm ci` で入れる。

## ローカルでの確認
```sh
npm test
```
期待する結果: 型の検査（Node と、顧客のアプリの画面）と lint が通り、テストが `51 passed` になる。続けて、CloudFormation のテンプレートの検査（`scripts/check-templates.sh`）が、何も出さずに通る。認可サーバーとログインサーバーの拡張（Java）の単体のテストは、イメージのビルドの中で回る（次の節）。

## ログインをローカルで確かめる（段 D の D1-a2-1）
`local/up.sh` は、PostgreSQL、SPIRE、ログインサーバー（`services/keycloak`）、認可サーバー（`services/auth`）、顧客のアプリ（`services/customer-app`）、入口のリバースプロキシを立てる。入口は `http://gekko13.localhost:18000/` で、固定の利用者（alice など）のパスワードは `demo` である。確かめは、Docker の Playwright のブラウザと仮想の認証器で回す。

```sh
local/up.sh
docker run -d --rm --name gekko13-browser --network host --init --add-host gekko13.localhost:127.0.0.1 \
  mcr.microsoft.com/playwright:v1.64.1-noble npx -y playwright@1.64.1 run-server --port 3334 --host 127.0.0.1
node scripts/ui-login.ts
```

期待する結果: `1 パスワードでログイン`、`2 パスキーを登録`、`3 パスキーでログイン` の 3 行がどれも `"ok":true` で、最後に `"判定","ok":true` と出る。ログインサーバーの起動に 1 分ほどかかるので、`local/up.sh` の直後は失敗することがある。1 つのサービスだけを作り直すときは `local/up.sh <サービス>`（keycloak、auth、customer-app、entry）を回す。レルムの JSON を直したときは `local/reset-keycloak.sh` を回す（レルムは、すでにあれば取り込まない）。

## AWS で作る
作る前に、変更をコミットしておく。イメージのタグは、イメージごとの材料のコミットした中身から作る（`scripts/image-tag.sh`）。材料にコミットしていない変更があると、`aws/deploy.sh` は `材料にコミットしていない変更がある` と出して止まる。材料が変わらないイメージは作り直さず、そのタスクも入れ替わらない。どのコミットから作ったかは、イメージのラベル `org.opencontainers.image.revision` に残る。

1. `aws sts get-caller-identity` で、作る先のアカウントが正しいかを確かめる。出力は記録に残さない。
2. インスタンスを 2 つの AZ に置き、上限 2 台にして作る。インスタンスは全部スポットで起き、種類は t4g.medium、c6g.large、c7g.large、t4g.large から、空きが多く安いものが選ばれる。種類を変えるときは、`GEKKO13_INSTANCE_TYPES` に、ちょうど 4 つをカンマで並べる。

```sh
GEKKO13_AZS=2 GEKKO13_MAX_HOSTS=2 aws/deploy.sh
```

期待する結果: 最後に `作った。入口: https://<配信の名前>/ 。…` と出る。作るスタックは 7 つである。順に registry、network、db（Aurora）、ecs（基盤）、apps、entry（入口のリバースプロキシ）、edge（ディストリビューション）。registry は、イメージとリバースプロキシの zip の置き場である。db は、初めて作るときに 10 分ほどかかる。作った直後は、キャパシティプロバイダーがインスタンスを起動し、spire-server、auth、keycloak、edge-check が 2 タスクずつ動く。どれも 2 つの AZ に散らすので、インスタンスは 2 台になる。

`aws/deploy.sh` は、初めて回すときに、秘密を作って SSM の SecureString に置く。Aurora の管理者とサービスごとのパスワード、auth の署名鍵、SPIRE のルート CA の鍵と証明書である。どれも、すでにあれば作り直さない。SPIRE のルート CA は、鍵と証明書の片方だけがあると止まる（作り直すと、トラストアンカーが替わるため）。ディストリビューションを初めて作ったときは、keycloak が 0 タスクのままになる（ディストリビューションのドメイン名から、自分の URL を作るため）。そのときは、もう一度 `aws/deploy.sh` を回す。

メモリを測るときは、`GEKKO13_CONTAINER_INSIGHTS=enabled` を足す。測り終えたら、付けずに回し直して止める。

## インスタンスを起動する・0 にする
```sh
aws/scale.sh up      # 自動の増減を 2〜4 に戻し、spire-server、auth、keycloak、edge-check を 2 にして、安定するまで待つ
aws/scale.sh down    # 自動の増減を 0 にし、DAEMON 以外の全サービスを 0 にし、ASG の希望台数も 0 にして、台が 0 になるまで待つ
```

期待する結果: `up` は数分で `安定した（台 2 台）` と出る。`down` は約 3 分で `台が 0 になった` と出る。SPIRE の登録と、Keycloak と auth のデータは Aurora に残り、ルート CA も変わらないので、`up` のあとも作り直しは要らない。Aurora が止まっていれば、SPIRE server のタスクの db-init が、再開するまで待つ（約 15 秒）。`up` で戻すタスク数は、`GEKKO13_EDGE_TASKS` で変えられる。

## 入口（CloudFront とリバースプロキシ）
入口は、CloudFront のディストリビューション（スタック `gekko13-edge`）から、入口のリバースプロキシ（スタック `gekko13-entry`、Lambda の Web Functions）を通る。CloudFront は OAC でリクエストに署名し、リバースプロキシは IAM の認証で、このディストリビューションからのリクエストだけを受ける。リバースプロキシは、パスで送り先を決める。`/login` と `/login/*` は keycloak へ、それ以外は顧客のアプリ（customer-app）へ送る（段 D の D1-a2）。edge-check は、入口から外した。送り先は、名前空間 `svc.gekko13.internal` の SRV で見つける。ECS が正常なタスクを SRV に登録するので、インスタンスが入れ替わっても手で向け直すことはない。

起動したあとに、入口を通して届くかを確かめる。

```sh
D=$(aws cloudformation describe-stacks --region ap-northeast-1 --stack-name gekko13-edge \
  --query "Stacks[0].Outputs[?OutputKey=='DomainName'].OutputValue" --output text)
curl -s "https://$D/login/realms/insurer/.well-known/openid-configuration" | head -c 120; echo
curl -s "https://$D/config.json"; echo
```

期待する結果: `{"issuer":"https://<配信の名前>/login/realms/insurer"` で始まる JSON が出る。続けて、顧客のアプリの設定（`appOrigin` と `rpId`）が出る。

ログインとパスキーは、手元と同じ `scripts/ui-login.ts` で、入口を指して確かめる。ブラウザは手元の Docker の Playwright（前の節）を使う。固定の利用者のパスワードは、`aws/deploy.sh` が乱数で作り、SSM の `/gekko13/login/demo-password` に置いてある。値を画面やファイルに残さず、環境変数で渡す。

```sh
DEMO_PASSWORD=$(aws ssm get-parameter --region ap-northeast-1 --name /gekko13/login/demo-password --with-decryption --query Parameter.Value --output text) \
  node scripts/ui-login.ts "https://$D"
```

ディストリビューションのドメイン名（`dXXXX.cloudfront.net`）は、パスキーの RP ID になるので変えない。スタックは消してもディストリビューションが残る作り（`DeletionPolicy: Retain`）にしてある。

リバースプロキシの記録は、CloudWatch Logs の `/aws/lambda/web/gekko13-entry` にある。送り先が見つからないと `no-target`、つながらないと `upstream-failed` の行が出る。

## 使わない間の費用
使わない間は、`aws/scale.sh down` でタスクとインスタンスを 0 にするだけにし、スタックは消さない。戻すのは `aws/scale.sh up` だけで足りる。ディストリビューションは有効なまま残り、送り先のタスクがない間は、リバースプロキシが 503 の `no target` を返す。

止めている間に残る固定費は、次の 5 つである。入口のリバースプロキシには固定費がない（[AWS の費用の見込み](#aws-の費用の見込み)）。
- Cloud Map のホストゾーン（月 0.5 ドル）
- マネージドスケーリングのアラーム 2 つと、タスクのオートスケーリングのアラーム 4 つ（1 つ月 0.1 ドル。合わせて月約 0.6 ドル）
- Aurora の保存（1 GB 月 0.12 ドル）。計算は、つながりがなくなって 5 分で止まり、0 になる
- ECR のイメージの保存
- EFS の保存

## 段 D の D0-b を測る
インスタンスが 0 の状態から、入口を通して使えるまでの時間を測る。測り方の定義（始点、終点、判定）は [log.md の 2026-11-21 の決定](log.md#決めたこと) にある。

```sh
aws/scale.sh down
aws/d0-measure.sh
```

期待する結果: `+N 秒: …` の行が、出来事の順に出る。おおよその順は次のとおり。
1. インスタンスが ASG に加わる。
2. 各サービスが RUNNING になる。
3. Cloud Map のインスタンスが HEALTHY になり、CloudFront を通して Keycloak と 2 つの AZ の edge-check が応える。
4. auth が起動する（Keycloak より先のこともある）。

最後に表と `判定（300 秒以内か）` が出て、`local/run/d0/<時刻>/result.md` に残る。インスタンスは動いたままなので、次の回の前と、終わったあとに `aws/scale.sh down` を回す。`local/down.sh` は `local/run/` を消すので、結果は先に写す。

## 段 D の D1-a1: インスタンスを 1 台止めて確かめる
インスタンスを 1 台、予告なしに止め、入口からのリクエストがどれだけ失敗するかを測る（plan.md の 4-3 の D1-a1 の予測）。スポットの中断（2 分前に予告がある）より厳しい条件である。

```sh
aws/scale.sh up
aws/failover-check.sh
```

期待する結果: 止めるインスタンスに載っていたタスクの一覧が出て、`始点: 台を止めた` と出る。8 分見たあと、`/edge-point` と Keycloak の discovery の、呼んだ数、失敗の数、最初と最後の失敗の秒の表が出る。代わりの auth が起動した秒も出る（auth は SVID がないと起動しないので、新しいタスクに SVID が出たことも分かる）。結果は `local/run/failover/<時刻>/result.md` に残る。ASG が代わりのインスタンスを起動するので、終わったら `aws/scale.sh down` を回す。

## 第 1 部と段 C の名残
次のスクリプトとスタックは、段 D の D0 から AWS で使わない（`aws/park.sh` と `scripts/vpc-origin-sg.sh` は D0-b から）。AWS の作りが変わったので、今は動かない。第 2 部の完成のときに、持ち主の承認を得て消す（[plan.md の 7 節](plan.md#7-制約と第-2-部の完成)）。
- スクリプト: `aws/run-scenarios.sh`、`aws/create-user.sh`、`aws/edge-point.sh`、`aws/c3-measure.sh`、`aws/park.sh`、`scripts/vpc-origin-sg.sh`、`scripts/aws-login.ts`、`scripts/aws-collect.ts`
- テンプレート: `aws/cognito.yaml`（スタック `gekko13-cognito` も残っている）

第 1 部のサービスのコード（`services/bff`、`services/transfer`、`services/ledger`、`services/issuer`）と、C-4 の確かめ（`scripts/c4-check.ts`）は、段 D の D1-a2 で認可サーバーを gekko_11 のものに替えたので、動かない。`local/up.sh` も立てない。

## 後片付け
インスタンスを 0 にするだけなら、`aws/scale.sh down` で足りる。全部を消すときは、スタックを作った順の逆に消す。消す前に、対象を一覧で確かめる。

```sh
aws cloudformation list-stacks --region ap-northeast-1 \
  --query "StackSummaries[?starts_with(StackName,'gekko13-') && StackStatus!='DELETE_COMPLETE'].StackName"
aws ssm get-parameters-by-path --region ap-northeast-1 --path /gekko13 --recursive --query 'Parameters[].Name'
aws servicediscovery list-namespaces --region ap-northeast-1 --query 'Namespaces[].[Id,Name]'
```

確かめたら、次の順に `aws cloudformation delete-stack` で消す。
1. `gekko13-edge`: OAC と、リバースプロキシのリソースポリシーが消える。ディストリビューションは残る（次の段落）。
2. `gekko13-entry`: 入口のリバースプロキシ、NetworkConnector とその ENI が消える。
3. `gekko13-apps`: アプリのサービス、タスク定義、SRV のサービス、タスクのオートスケーリングが消える。オートスケーリングのアラームの固定費は、ここで止まる。
4. `gekko13-ecs`: ECS のクラスター、SPIRE、ASG とインスタンス、Cloud Map の名前空間、ロググループが消える。ホストゾーンとアラームの固定費は、ここで止まる。
5. `gekko13-db`: Aurora のクラスターとインスタンスが消える。最後のスナップショットは残さないので、Keycloak の利用者とパスキー、SPIRE の登録、auth の記録も消える。
6. `gekko13-cognito`: 第 1 部の利用者と client が消える。
7. `gekko13-network`: VPC と EFS が消える。EFS が消えると、SPIRE の CA と登録も消え、次に作るときは新しい CA になる。D0 までに CloudFront が VPC に作ったグループ（`CloudFront-VPCOrigins-Service-SG`）が残っていると、VPC を消せない（推定）。
8. `gekko13-registry`: ECR のイメージは、リポジトリと一緒に消える（`EmptyOnDelete`）。リバースプロキシの zip の置き場（S3）は、中身を消してからでないと消えない。

`gekko13-edge` の CloudFront のディストリビューションは、スタックを消しても残る。ディストリビューションを消すと、RP ID が使えなくなり、登録したパスキーも使えなくなる。消すときは、先にディストリビューションを無効にしてから、`aws cloudfront delete-distribution` で消す。

SSM のパラメーターは、スタックの外で作ったので、`aws ssm delete-parameters` で消す。消すのは次の 4 組で、合わせて 14 個である。
- `/gekko13/auth/` の standin-secret と signing-key
- `/gekko13/db/` の 4 つのパスワードと ca
- `/gekko13/spire/` の root-key と root-cert
- 第 1 部の 4 つ（BFF と transfer の client の秘密、リフレッシュトークン、プローブの動かし方）

SPIRE のルート CA を消すと、次に作るときは新しい根になる。最後に、`list-namespaces` に `svc.gekko13.internal` が残っていないかを確かめる。残っていれば、月額のかかるホストゾーンも残っている（[findings 2-5](findings.md#2-5-作成中に巻き戻すとcloud-map-の名前空間がスタックの外に残った)）。

ローカルは `local/down.sh` で消す。消えるのは、`gekko13=1` のラベルを付けたコンテナ、`gekko13` のネットワークとボリューム、`local/run/` の全部。

## AWS の費用の見込み
単価は東京リージョンの値。EC2 は 2026-11-15 に gekko_12 の設計判断 5 節で、ほかは 2026-11-16 に料金の API で確かめた。

| 部品 | 費用 | いつかかるか |
|---|---|---|
| EC2（t4g.small） | 1 台 1 時間 0.0216 ドル | インスタンスが動いている間 |
| EC2（t4g.medium） | 1 台 1 時間 0.0432 ドル（料金の API、2026-11-20）。スポットは 1 時間 0.017〜0.019 ドル（スポットの価格の履歴、2026-11-21。時間で変わる） | インスタンスが動いている間。インスタンスは全部スポットで起動する |
| 入口のリバースプロキシ（Web Functions） | リクエスト 100 万件あたり 0.30 ドル、CPU 1 vCPU 秒あたり約 0.000032 ドル、メモリ 1 GB 秒あたり約 0.0000043 ドル（料金の API、2026-11-21）。環境は、リクエストが止んでから約 5 分残る（gekko_10 の実測 1-7） | リクエストを受けている間。使わない間は 0 |
| NetworkConnector | 料金表に項目がない（2026-11-21）。サービス管理の Elastic IP は付けない（付けると固定費） | — |
| Container Insights | CloudWatch のメトリクスの従量。数時間なら数セント（推定） | 有効にしている間 |
| EBS（gp3 30 GB） | 1 台あたり月約 2.9 ドルの日割り（推定。gekko_12 の 20 GB で月約 1.9 ドルから比例で出した） | インスタンスがある間。インスタンスが 0 なら 0 |
| Cloud Map のホストゾーン | 月 0.5 ドル | ECS のスタックがある間（インスタンスが 0 でも） |
| マネージドスケーリングのアラーム（2 つ） | 1 つ月 0.1 ドル | ECS のスタックがある間（インスタンスが 0 でも） |
| タスクのオートスケーリングのアラーム（4 つ） | 1 つ月 0.1 ドル | apps のスタックがある間（インスタンスが 0 でも） |
| Aurora Serverless v2 の計算 | 1 ACU 時間 0.15 ドル（料金の API、2026-11-21）。最大 2 ACU | つながりがある間と、なくなってから 5 分。止まれば 0 |
| Aurora の保存 | 1 GB 月 0.12 ドル（料金の API、2026-11-21） | db のスタックがある間 |
| EFS（Standard） | 1 GB あたり月 0.36 ドル。使うのは数 MB | network のスタックがある間 |
| ECR、CloudWatch Logs、SSM | ほぼ 0（保存と取り込みの従量。SSM の標準のパラメーターは無料）。ECR は、Keycloak と auth のイメージで約 1 GB 増え、月約 0.1 ドル（推定） | 使った分 |
| CloudFront のディストリビューション | 月の固定費はない。リクエストと転送の従量（試しの分はごく小さい。推定） | 使った分 |
| Egress-only のインターネットゲートウェイ | 追加の料金はない（資料。2026-11-19）。EC2 の転送の従量はかかる | — |

## つまずきやすい点
- **SPIRE server のタスクが起きず、db-init のログに `Aurora を待つ` が続く:** Aurora に届かないか、証明書が合わない。3 分で、最後の誤りを出して止まる。インスタンスのグループから Aurora の 5432 への出口の規則（db のスタック）と、`/gekko13/db/ca` が `aws/rds-ca.pem` と同じかを確かめる。
- **新しいインスタンスの spire-agent が、最初の数十秒、止まっては再起動する:** EFS の最初のバンドルが、新しいルート CA に替わる前の古いもののことがある。SPIRE server のタスクの registrar が書き直せば収まる（推定）。
- **`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`:** Node.js の型の取り除きは `node_modules` の中で動かない。パッケージは相対パスで読む。
- **`aws/deploy.sh` が、テンプレートの検査で止まる:** テンプレートのコメント以外の行に、日本語がある。CloudFormation は、ASCII 以外の文字を「?」に置き換える。Description と Metadata は英語で書き、日本語は `#` のコメントに移す（[findings 2-1](findings.md#2-1-cloudformation-はテンプレートの-ascii-以外の文字をに置き換えた)）。
- **ECS のスタックが `ROLLBACK_COMPLETE` になった:** そのままでは作り直せない。資源が残っていないのを確かめてから消し、作り直す。作成中に巻き戻ったときは、Cloud Map の名前空間がスタックの外に残ることがあるので、`aws servicediscovery list-namespaces` で確かめる（[findings 2-5](findings.md#2-5-作成中に巻き戻すとcloud-map-の名前空間がスタックの外に残った)）。
- **spire-agent のタスクが、止まっては再起動する:** インスタンスを起動した直後の 1 分ほどは、agent が server より先に起きる。そのため、server に届かずに止まる。server が起きれば安定する。server がいないまま 5 分ほどたつと、agent の SVID が切れて止まり続ける（[findings 3-4](findings.md#3-4-server-が-5-分ほどいないとagent-は自分の-svid-が切れて止まった)）。spire-server のサービスが動いているかを見る。
- **agent が「attestation data has already been used」で止まる:** aws_iid は、同じインスタンスで一度しか確認を通さない。ホストの `/var/lib/gekko13/spire-agent` が消えたときに起きる。インスタンスを入れ替える（`scale.sh down` と `up`）。
- **ホストの中を見たい:** IPv6 だけのインスタンスは、Session Manager に登録されなかった（[findings 2-11](findings.md#2-11-ipv6-だけのインスタンスはsession-manager-に登録されなかった)）。サブネットに IPv4 の経路がないので、公開 IPv4 を付けて入る逃げ道もない。中の様子は、CloudWatch Logs と ECS の API で見る。
- **`aws/deploy.sh` が「Templates with a size greater than 51,200 bytes」で止まる:** 送る前のコメントの除去が効いていない。`aws/deploy.sh` は ECS とアプリのテンプレートの行頭のコメントを除いてから送る。コメントでない行が増えて 51,200 バイトを超えたら、テンプレートをさらに分ける（[findings 4-12](findings.md#4-12-日本語のコメントを含めた-ecs-のテンプレートは直接送れる大きさ51200-バイトを超えた)）。
- **起動テンプレートを変えたのに、インスタンスが古いまま:** スタックの更新の前から起きていたインスタンスは、古い起動テンプレートのまま残る。インスタンスの大きさを変えたときは、`aws/scale.sh down` で 0 にしてから起動する（[findings 4-14](findings.md#4-14-ecs-のスタックの更新が止まる前に起きたインスタンスは古い起動テンプレートのまま残った)）。
- **auth が「Error reading certificate or key from file」で起きない:** インスタンスの helper の設定（`/etc/gekko13/spire/helper.conf`）に `key_file_mode = 0640` がない。古い起動テンプレートのインスタンスで起きる。インスタンスを入れ替える（[findings 4-13](findings.md#4-13-spiffe-helper-は-root-で動き鍵を-0600-で書いたのでroot-でない利用者のアプリは鍵を読めなかった)）。
- **インスタンスが予告なく入れ替わった:** スポットの中断か、中断の危険が高まったインスタンスの入れ替え（CapacityRebalance）である。ECS のエージェントが、予告を受けてタスクを別のインスタンスへ逃がす。1 タスクのサービス（spire-server、auth、keycloak）は、再起動するまで 3〜4 分止まり、Keycloak の利用者とパスキーは消える（推定）。`aws autoscaling describe-scaling-activities` で理由を見る。
- **CloudFront を通すと 503 の `no target` になる:** リバースプロキシが、送り先の SRV を見つけられない。タスクが正常でないか、まだ起きていない。`aws servicediscovery get-instances-health-status --service-id <id>` で見る（id は `gekko13-apps` の出力）。タスクのヘルスチェックのパスが 200 を返すかを確かめる。
- **CloudFront を通すと 502 の `bad gateway` になる:** リバースプロキシが、見つけたタスクにつながらない。リバースプロキシの記録の `upstream-failed` を見る。インスタンスのグループが、リバースプロキシのグループから動的なポート（32768〜65535）を受けているかを確かめる。
- **CloudFront を通すと 403 になる:** リバースプロキシのリソースポリシーが、このディストリビューションを許していない。`aws lambda-web get-resource-policy` で、`aws:SourceArn` がディストリビューションの ARN かを確かめる。
- **アプリのスタックの作成が、サービスを作るところで止まる:** 基盤のスタックから消したサービスが、まだ DRAINING で残っているおそれがある（推定）。`aws/deploy.sh` は 10 分まで待つ。それでも止まれば、`aws ecs describe-services` で状態を見て、待ってから回し直す。
