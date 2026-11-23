# 基盤の動かし方と後片付け

**この文書の読み手:** この検証の基盤（ECS on EC2、SPIRE、IPv6 だけの AWS）とアプリを自分で動かす開発者。作って、確かめ、インスタンスを起動し、0 にし、片付けるまでを扱う。何を確かめるかは [plan.md](plan.md)、判断の理由は [design-decisions.md](design-decisions.md)、用語は [用語集](glossary.md)。

## 要旨
- AWS は `aws/deploy.sh` で作り、`aws/scale.sh up` でインスタンスを起動し、`aws/scale.sh down` でタスクとインスタンスを 0 にする。
- 使わない間も、スタックは消さない。インスタンスとタスクを 0 にすれば、残る固定費はホストゾーンとアラームの月 1 ドル未満と、保存の費用だけになる（[使わない間の費用](#使わない間の費用)）。
- インスタンスはプライベートのサブネットに置き、外からは CloudFront から入口のリバースプロキシ（Lambda の Web Functions）を通してだけ届く。インスタンスが入れ替わっても、向け直しは要らない。
- 今の AWS のサービスは 7 つ。apps のスタックに keycloak と auth、flow のスタックに顧客のアプリ、営業 AI エージェント、事務サービス、保険会社のシステム、監査サービスがある。

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
期待する結果: 型の検査（Node と、顧客のアプリの画面）と lint が通り、テストが `76 passed` になる。続けて、事務サービス（Python）の lint と試験が `21 passed` になり、監査サービス（Go）の試験が `ok` になる。続けて、CloudFormation のテンプレートの検査（`scripts/check-templates.sh`）が、何も出さずに通る。認可サーバーとログインサーバーの拡張（Java）の単体のテストは、イメージのビルドの中で回る（次の節）。

## ログインをローカルで確かめる
`local/up.sh` は、PostgreSQL、SPIRE、入口のリバースプロキシと、次のサービスを立てる。ログインサーバー（`services/keycloak`）、認可サーバー（`services/auth`）、顧客のアプリ（`services/customer-app`）、営業 AI エージェント、事務サービス、保険会社のシステム、監査サービスである。入口は `http://gekko13.localhost:18000/` で、固定の利用者（alice など）のパスワードは `demo` である。確かめは、Docker の Playwright のブラウザと仮想の認証器で回す。

```sh
local/up.sh
docker run -d --rm --name gekko13-browser --network host --init --add-host gekko13.localhost:127.0.0.1 \
  mcr.microsoft.com/playwright:v1.64.1-noble npx -y playwright@1.64.1 run-server --port 3334 --host 127.0.0.1
node scripts/ui-login.ts
```

期待する結果: `1 パスワードでログイン`、`2 パスキーを登録`、`3 パスキーでログイン` の 3 行がどれも `"ok":true` で、最後に `"判定","ok":true` と出る。ログインサーバーの起動に 1 分ほどかかるので、`local/up.sh` の直後は失敗することがある。1 つのサービスだけを作り直すときは、`local/up.sh <サービス>` を回す。サービスの名前は、`local/up.sh` の冒頭にある。レルムの JSON を直したときは `local/reset-keycloak.sh` を回し、そのあと `docker restart gekko13-auth` で auth を起こし直す（レルムは、すでにあれば取り込まない。auth は、前の管理のトークンを持ち続ける）。

## 主の流れと監査の画面をローカルで確かめる
前の節のブラウザを立てたまま、主の流れの確かめを回す。営業 AI エージェントは台本で動く。

```sh
node scripts/ui-flow.ts
```

期待する結果: `1 ログイン` から `8c 監査の担当は顧客のアプリにログインできない` までの行がどれも `"ok":true` で、最後に `"判定","ok":true` と出る。8 の段は、監査の担当（kansa）が別のブラウザで `/audit` にログインして確かめる。顧客は監査の画面を、監査の担当は顧客のアプリを、ログインサーバーの画面で断られる。事務サービス（Python）の試験は `scripts/test-python.sh`、監査サービス（Go）の試験は `scripts/test-go.sh` で回る（`npm test` も回す）。保険会社のシステム（Java）の試験は、イメージのビルドの中で回る。

ホストが眠ったあとは、手元の SPIRE の agent が立ち直れず、SVID が書かれないことがある（[findings 5-22](findings.md#5-22-手元で主の流れの-27-段がenvoy-なしで通ったサービスのトークンの確かめはtypescriptpythonjava-の-3-つで共通の例-15-件の判定が全部一致した)）。そのときは `local/down.sh` と `local/up.sh` で作り直す。

## AWS で作る
作る前に、変更をコミットしておく。イメージのタグは、イメージごとの材料のコミットした中身から作る（`scripts/image-tag.sh`）。材料にコミットしていない変更があると、`aws/deploy.sh` は `材料にコミットしていない変更がある` と出して止まる。材料が変わらないイメージは作り直さず、そのタスクも入れ替わらない。どのコミットから作ったかは、イメージのラベル `org.opencontainers.image.revision` に残る。

1. `aws sts get-caller-identity` で、作る先のアカウントが正しいかを確かめる。出力は記録に残さない。
2. インスタンスを 2 つの AZ に置き、上限 2 台にして作る。インスタンスは全部スポットで起き、種類は t4g.medium、c6g.large、c7g.large、t4g.large から、空きが多く安いものが選ばれる。種類を変えるときは、`GEKKO13_INSTANCE_TYPES` に、ちょうど 4 つをカンマで並べる。

```sh
GEKKO13_AZS=2 GEKKO13_MAX_HOSTS=2 aws/deploy.sh
```

期待する結果: 最後に `作った。入口: https://<配信の名前>/ 。…` と出る。作るスタックは、次の 8 つの順である。

| 順 | スタック | 中身 |
|---|---|---|
| 1 | registry | イメージとリバースプロキシの zip の置き場 |
| 2 | network | VPC と EFS |
| 3 | db | Aurora |
| 4 | ecs | 基盤（クラスター、インスタンス、SPIRE） |
| 5 | apps | keycloak と auth |
| 6 | flow | 主の流れのサービス |
| 7 | entry | 入口のリバースプロキシ |
| 8 | edge | ディストリビューション |

db は、初めて作るときに 10 分ほどかかる。作った直後は、キャパシティプロバイダーがインスタンスを起動する。spire-server、auth、keycloak は 2 タスクずつ、主の流れのサービスは 1 タスクずつ動く。2 タスクのサービスは 2 つの AZ に散らすので、インスタンスは 2 台以上になる。サービスを新しく足したときは、送ったあとに、そのサービスを呼ぶ側のタスクを入れ替える（[findings 5-23](findings.md#5-23-aws-でも主の流れの-27-段が-cloudfront-を通して通った同時に作った-service-connect-のサービスどうしはタスクを入れ替えるまで互いの名前を引けなかった)）。

`aws/deploy.sh` は、初めて回すときに、秘密を作って SSM の SecureString に置く。Aurora の管理者とサービスごとのパスワード、auth の署名鍵、SPIRE のルート CA の鍵と証明書である。どれも、すでにあれば作り直さない。SPIRE のルート CA は、鍵と証明書の片方だけがあると止まる（作り直すと、トラストアンカーが替わるため）。ディストリビューションを初めて作ったときは、keycloak が 0 タスクのままになる（ディストリビューションのドメイン名から、自分の URL を作るため）。そのときは、もう一度 `aws/deploy.sh` を回す。

メモリを測るときは、`GEKKO13_CONTAINER_INSIGHTS=enabled` を足す。測り終えたら、付けずに回し直して止める。

## インスタンスを起動する・0 にする
```sh
aws/scale.sh up      # 全部のサービスを 2 にして、安定するまで待つ（タスクのオートスケーリングがあれば、幅を 2〜4 に戻す）
aws/scale.sh down    # DAEMON 以外の全サービスを 0 にし、ASG の希望台数も 0 にして、インスタンスが 0 になるまで待つ
```

期待する結果: `up` は数分で `安定した（台 N 台）` と出る。主の流れのサービスを足してからは、起動の途中で 6 台まで増え、安定すると 3 台ほどになった（2026-11-22）。`down` は約 3 分で `台が 0 になった` と出る。SPIRE の登録と、Keycloak と auth のデータは Aurora に残り、ルート CA も変わらないので、`up` のあとも作り直しは要らない。Aurora が止まっていれば、SPIRE server のタスクの db-init が、再開するまで待つ（約 15 秒）。

## 入口（CloudFront とリバースプロキシ）
入口は、CloudFront のディストリビューション（スタック `gekko13-edge`）から、入口のリバースプロキシ（スタック `gekko13-entry`、Lambda の Web Functions）を通る。CloudFront は OAC でリクエストに署名し、リバースプロキシは IAM の認証で、このディストリビューションからのリクエストだけを受ける。リバースプロキシは、パスで送り先を決める。`/login` と `/login/*` は keycloak へ、`/audit` と `/audit/*` は監査サービス（insurer-audit）へ、それ以外は顧客のアプリ（customer-app）へ送る。送り先は、名前空間 `svc.gekko13.internal` の SRV で見つける。ECS が正常なタスクを SRV に登録するので、インスタンスが入れ替わっても手で向け直すことはない。

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

主の流れと監査の画面は、手元と同じ `scripts/ui-flow.ts` に入口を渡して確かめる（固定の利用者のパスワードの渡し方は上と同じ）。

レルムの JSON（`services/keycloak/realm/insurer.json`）を直したときは、`aws/reset-keycloak.sh --yes` で Aurora の Keycloak のデータベースを作り直し、取り込み直させる。利用者が登録したパスキーとセッションは消え、戻せない。回す前に持ち主の承認を得る。作り直したあとは、auth のタスクを入れ替える（`aws ecs update-service --service auth --force-new-deployment`）。auth は、作り直す前の Keycloak の管理のトークンを持ち続け、連絡先とパスキーの一覧の呼び出しが 401 になる。

ディストリビューションのドメイン名（`dXXXX.cloudfront.net`）は、パスキーの RP ID になるので変えない。スタックは消してもディストリビューションが残る作り（`DeletionPolicy: Retain`）にしてある。

リバースプロキシの記録は、CloudWatch Logs の `/aws/lambda/web/gekko13-entry` にある。送り先が見つからないと `no-target`、つながらないと `upstream-failed` の行が出る。

## ダッシュボードで観察する
`aws/deploy.sh` が、CloudWatch のダッシュボード `gekko13` を作る（スタック `gekko13-dashboard`）。URL は、スタックの出力 `DashboardUrl` にある。

| 段 | 見るもの |
|---|---|
| 1 | いまの値（インスタンス数、サービスごとのタスク数、Aurora の ACU と接続数、CloudFront の要求数と 5xx の割合） |
| 2 | 推移（インスタンス数、マネージドスケーリングの値、タスク数、Aurora の ACU） |
| 3 | 性能（サービスごとのメモリと CPU、Aurora の接続数、CloudFront の 5xx の割合） |
| 4 | 入口のリバースプロキシの応答、主の流れの監査の記録、サービスごとの失敗の合計、各サービスが起動を終えた時刻 |

マネージドスケーリングの値は、要るインスタンスの数を動いている数で割った割合で、100 がちょうど足りている状態である。100 を超えると、インスタンスを増やす。メトリクスの参照は 43 個で、無料枠（3 つまで、1 つに 50 まで）に収まる。下の段のログの集計は、開いて読み込むたびに、読んだ量の料金がかかる（無料枠は月 5 GB）。時間の幅を広げすぎない。

## 使わない間の費用
使わない間は、`aws/scale.sh down` でタスクとインスタンスを 0 にするだけにし、スタックは消さない。戻すのは `aws/scale.sh up` だけで足りる。ディストリビューションは有効なまま残り、送り先のタスクがない間は、リバースプロキシが 503 の `no target` を返す。

止めている間に残る固定費は、次の 5 つである。入口のリバースプロキシには固定費がない（[AWS の費用の見込み](#aws-の費用の見込み)）。
- Cloud Map のホストゾーン（月 0.5 ドル）
- マネージドスケーリングのアラーム 2 つ（1 つ月 0.1 ドル。合わせて月約 0.2 ドル）。タスクのオートスケーリングは、既定では作らない（`GEKKO13_AUTOSCALING=true` で作ると、アラームが 4 つ増える）
- Aurora の保存（1 GB 月 0.12 ドル）。計算は、つながりがなくなって 5 分で止まり、0 になる
- ECR のイメージの保存
- EFS の保存

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
3. `gekko13-flow` と `gekko13-apps`: アプリのサービス、タスク定義、SRV のサービス、タスクのオートスケーリングが消える。オートスケーリングのアラームの固定費は、ここで止まる。
4. `gekko13-ecs`: ECS のクラスター、SPIRE、ASG とインスタンス、Cloud Map の名前空間、ロググループが消える。ホストゾーンとアラームの固定費は、ここで止まる。
5. `gekko13-db`: Aurora のクラスターとインスタンスが消える。最後のスナップショットは残さないので、Keycloak の利用者とパスキー、SPIRE の登録、auth の記録も消える。
6. `gekko13-network`: VPC と EFS が消える。EFS が消えると、SPIRE の CA と登録も消え、次に作るときは新しい CA になる。D0 までに CloudFront が VPC に作ったグループ（`CloudFront-VPCOrigins-Service-SG`）が残っていると、VPC を消せない（推定）。
7. `gekko13-registry`: ECR のイメージは、リポジトリと一緒に消える（`EmptyOnDelete`）。リバースプロキシの zip の置き場（S3）は、中身を消してからでないと消えない。

`gekko13-edge` の CloudFront のディストリビューションは、スタックを消しても残る。ディストリビューションを消すと、RP ID が使えなくなり、登録したパスキーも使えなくなる。消すときは、先にディストリビューションを無効にしてから、`aws cloudfront delete-distribution` で消す。

SSM のパラメーターは、スタックの外で作ったので、`aws ssm delete-parameters` で消す。消すのは `/gekko13/` の下の全部で、上の `get-parameters-by-path` で一覧を出してから消す。
- `/gekko13/auth/` の signing-key
- `/gekko13/db/` の 4 つのパスワードと ca
- `/gekko13/spire/` の root-key と root-cert、bundle endpoint の bundle-tls-key と bundle-tls-cert
- `/gekko13/login/` の demo-password

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
- **インスタンスが予告なく入れ替わった:** スポットの中断か、中断の危険が高まったインスタンスの入れ替え（CapacityRebalance）である。ECS のエージェントが、予告を受けてタスクを別のインスタンスへ逃がす。1 タスクのサービス（主の流れの 5 つ）は、別のインスタンスで起き直すまで止まり、メモリに持つ状態（セッション、会話、契約）は消える（推定。冗長化は D1-a3 で行う）。spire-server、auth、keycloak は 2 タスクで、データは Aurora に残る。`aws autoscaling describe-scaling-activities` で理由を見る。
- **CloudFront を通すと 503 の `no target` になる:** リバースプロキシが、送り先の SRV を見つけられない。タスクが正常でないか、まだ起きていない。`aws servicediscovery get-instances-health-status --service-id <id>` で見る（id は `gekko13-apps` か `gekko13-flow` の出力）。タスクのヘルスチェックのパスが 200 を返すかを確かめる。
- **CloudFront を通すと 502 の `bad gateway` になる:** リバースプロキシが、見つけたタスクにつながらない。リバースプロキシの記録の `upstream-failed` を見る。インスタンスのグループが、リバースプロキシのグループから動的なポート（32768〜65535）を受けているかを確かめる。
- **CloudFront を通すと 403 になる:** リバースプロキシのリソースポリシーが、このディストリビューションを許していない。`aws lambda-web get-resource-policy` で、`aws:SourceArn` がディストリビューションの ARN かを確かめる。
- **アプリのスタックの作成が、サービスを作るところで止まる:** 基盤のスタックから消したサービスが、まだ DRAINING で残っているおそれがある（推定）。`aws/deploy.sh` は 10 分まで待つ。それでも止まれば、`aws ecs describe-services` で状態を見て、待ってから回し直す。
