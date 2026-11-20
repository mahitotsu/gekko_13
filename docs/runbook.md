# 基盤の動かし方と後片付け

**この文書の読み手:** この検証の基盤（ECS on EC2、SPIRE、IPv6 だけの AWS）を自分で動かす開発者。作って、台を起こし、0 にし、片付けるまでを扱う。アプリとシナリオの動かし方は、段 D で足す。何を確かめるかは [plan.md](plan.md)、判断の理由は [design-decisions.md](design-decisions.md)、用語は [用語集](glossary.md)。

## 要旨
- AWS は `aws/deploy.sh` で作り、`aws/scale.sh up` で台を起こし、`aws/scale.sh down` でタスクと台を 0 にする。
- 台が 0 の間も、月額の固定費（ホストゾーンとアラーム）と、保存の費用は残る（[AWS の費用の見込み](#aws-の費用の見込み)）。
- 台はプライベートのサブネットに置き、外からは CloudFront の VPC origin でだけ届く。台を起こしたら、`aws/edge-point.sh` で入口を向ける。
- 今の AWS の作りは、第 1 部のアプリ（bff、transfer、ledger）に、C-3 の keycloak と auth を足したもの。第 2 部のアプリは、段 D で入れ替える。

## 実行前の約束
- AWS に資源を作る前に、持ち主に確かめる。費用は [AWS の費用の見込み](#aws-の費用の見込み) のとおり。
- スタックの削除などの戻しにくい操作は、先に対象を一覧で見せて、承認を得る。
- 秘密、トークン、アカウント ID を、画面の出力やファイルに残さない。手順のスクリプトは、どれも出さないように書いてある。

## 前提
- Node.js 24 以上、docker（buildx を含む）、openssl。`docker compose` は要らない。
- AWS の段では、AWS CLI v2 も要る。
- AWS の段では、東京リージョン（ap-northeast-1）で、次の資源を作れる権限が要る。
  - 基盤: CloudFormation、IAM、EC2、Auto Scaling、ECS、ECR
  - 保存と発見: EFS、Cloud Map、Route 53（Cloud Map が作るホストゾーン）
  - 認証と記録: Cognito、SSM、CloudWatch Logs
- 依存は `npm ci` で入れる。

## ローカルでの確認
```sh
npm test
```
期待する結果: 型の検査と lint が通り、単体のテストが `11 passed` になる。続けて、CloudFormation のテンプレートの検査（`scripts/check-templates.sh`）が、何も出さずに通る。認可サーバー（Java）の単体のテストは、イメージのビルドの中で回る（次の節）。

## 認可サーバーをローカルで確かめる
`local/up.sh` は、第 1 部のサービスに加えて、認可サーバー（`services/auth`、Spring Authorization Server）を立てる。イメージは `services/auth/Dockerfile` から作り、ビルドの中で `mvn test` を回す。段 C の C-4 の判定は、次のとおりに回す。

```sh
SVID_TTL=120 local/up.sh
node scripts/c4-check.ts
local/down.sh
```

期待する結果: `7/7 合格` と出る。最後の C4-7 は、SVID が入れ替わるのを待つので、1〜2 分かかる。`SVID_TTL` を付けないと、待ちは約 3 分になる。判定の中身は [findings 4-4](findings.md#4-4-spring-authorization-server-はenvoy-なしで-svid-の-mtls-を自分で終え交換したトークンを呼び手の-svid-の証明書に結んだ)。

## AWS で作る
作る前に、変更をコミットしておく。イメージのタグはコミットから作り、変更が残っていれば `-dirty` を付ける。同じ `-dirty` のタグでは、中身を直しても古いイメージが使われる（ECR のタグは変えられない）。

1. `aws sts get-caller-identity` で、作る先のアカウントが正しいかを確かめる。出力は記録に残さない。
2. `aws/deploy.sh <ドメインの接頭辞>` を実行する。接頭辞は、マネージドログインのドメインになり、リージョンの中で一意にする。作り直すときは、前と同じ接頭辞を渡す。前の接頭辞は次のコマンドで分かる。

```sh
aws cloudformation describe-stacks --region ap-northeast-1 --stack-name gekko13-cognito \
  --query "Stacks[0].Parameters[?ParameterKey=='DomainPrefix'].ParameterValue" --output text
```

3. 段 B（2 つの AZ、各サービス 2 タスク）にするときは、環境変数を付けて実行する。

```sh
GEKKO13_AZS=2 GEKKO13_TASKS=2 GEKKO13_MAX_HOSTS=4 aws/deploy.sh <ドメインの接頭辞>
```

4. 段 C の C-3 を測るときは、台を t4g.medium の 1 台にし、メモリの測定（Container Insights）を有効にする。

```sh
GEKKO13_INSTANCE_TYPE=t4g.medium GEKKO13_MAX_HOSTS=1 GEKKO13_CONTAINER_INSIGHTS=enabled aws/deploy.sh <ドメインの接頭辞>
```

期待する結果: 最後に `作った。使い終わったら aws/scale.sh down で、タスクと台を 0 にする` と出る。作った直後は、キャパシティプロバイダーが台を起こす。SPIRE server と 5 つのサービス（bff、transfer、ledger、auth、keycloak）が、1 タスクずつ動く。段 B では、bff、transfer、ledger が 2 タスクずつになる。keycloak は、入口の配信がまだなければ 0 タスクのままになる（配信の名前から、自分の URL を作るため）。プローブの 3 つのサービス（probe-bff、probe-transfer、probe-ledger）は、タスク数 0 のままになる。

## 台を起こす・0 にする
```sh
aws/scale.sh up      # SPIRE server、edge-check、auth、keycloak を 1、bff、transfer、ledger を 1（引数で数を変えられる）にして、安定するまで待つ
aws/scale.sh down    # タスクを 0 にし、ASG の希望台数も 0 にして、台が 0 になるまで待つ
```

期待する結果: `up` は数分で `安定した（台 2 台）` のように出る。0 台から起こすと、1 台で足りても 2 台が起きることがある（[findings 3-2](findings.md#3-2-0-台から起こすときマネージドスケーリングは-2-台を起こした)）。`down` は約 3 分で `台が 0 になった` と出る。SPIRE の CA と登録は EFS に残るので、`up` のあとも作り直しは要らない（[findings 3-3](findings.md#3-3-台を-0-にして起こし直してもefs-の上の-spire-の-ca-と登録は残った)）。

## 入口（CloudFront）を台に向ける
CloudFront の配信（スタック `gekko13-edge`）の送り先（VPC origin）を、確認用のサービス（edge-check）が動いている台に向ける。台を起こしたあとと、台が入れ替わったあとに実行する。配信がなければ作る。

```sh
aws/edge-point.sh
```

期待する結果: `組: A → B` のように、切り替える組が出る。続けて `届いた /edge-point: …` が出て、確認用のサービスの JSON（`"via_cloudfront":true`、`"listener":"app"`）が出る。そのあと `届いた /login/realms/gekko13/.well-known/openid-configuration: …` が出て、Keycloak の JSON（`"issuer":"https://<配信の名前>/login/realms/gekko13"`）が出る。書き換えを求めてから届くまで、3〜6 分かかる。その間は前の台を指したままなので、届かない（[findings 4-9](findings.md#4-9-cloudfront-は配信が使っている-vpc-origin-の更新を拒んだvpc-origin-を-2-組持って切り替えると向け直しは-36-分だった)）。台が変わっていなければ、何も変えずに確かめるだけで終わる。30 分で届かなければ止まる。

初めて VPC origin を作ったときは、CloudFront が VPC にグループ（`CloudFront-VPCOrigins-Service-SG`）を作る。`edge-point.sh` はこれを network のスタックに渡し、台がそこから 8080〜8081 を受けるようにする。`aws/deploy.sh` も、このグループがあれば渡し続ける。

配信の名前（`dXXXX.cloudfront.net`）は、パスキーの RP ID になるので変えない。スタックは消しても配信が残る作り（`DeletionPolicy: Retain`）にしてある。`aws/deploy.sh` は、この名前を edge-check の RP ID として渡す。配信を初めて作ったあとは、`aws/deploy.sh` をもう一度実行する。

`/login/*` は Keycloak（台の 8081）に届く。Keycloak は、edge-check と同じ台にいないと届かない。台が 2 台以上のときは、`aws ecs describe-tasks` で 2 つのタスクの台を確かめる（[design-decisions](design-decisions.md)）。C-2 のパスキーの試しの画面（edge-check の 8081）は、もう CloudFront から届かない。端末の側に `gekko13` のパスキーが残っていれば、端末の設定（Windows なら「アカウント」の「パスキー」）から消す。

## 段 C の C-3 を測る
台が 0 の状態から、Keycloak と auth が使えるまでの時間を測る。測り方の定義（始点、終点、判定）は [log.md の 2026-11-20 の決定](log.md#決めたこと) にある。上の「AWS で作る」の 4 で作ってから、次のとおりに回す。

```sh
aws/scale.sh down
aws/c3-measure.sh        # 30 分置く分を含めて、約 40 分。引数に 0 を渡すと、置かずに終わる
```

期待する結果: `+N 秒: …` の行が、出来事の順に出る（台が ASG に加わる、各サービスが RUNNING になる、向け直し、Keycloak が応える、auth が起動する）。最後に表と `判定（600 秒以内か）` が出て、`local/run/c3/<時刻>/result.md` に残る。30 分置いたあとは、止まったタスクと、サービスごとのメモリの最大が出る。台は動いたままなので、次の回の前と、終わったあとに `aws/scale.sh down` を回す。測り終えたら、`GEKKO13_CONTAINER_INSIGHTS` を付けずに `aws/deploy.sh` を回して、メモリの測定を止める。`local/down.sh` は `local/run/` を消すので、結果は先に写す。

## 後片付け
台を 0 にするだけなら、`aws/scale.sh down` で足りる。全部を消すときは、スタックを作った順の逆に消す。消す前に、対象を一覧で確かめる。

```sh
aws cloudformation list-stacks --region ap-northeast-1 \
  --query "StackSummaries[?starts_with(StackName,'gekko13-') && StackStatus!='DELETE_COMPLETE'].StackName"
aws ssm get-parameters-by-path --region ap-northeast-1 --path /gekko13 --recursive --query 'Parameters[].Name'
aws servicediscovery list-namespaces --region ap-northeast-1 --query 'Namespaces[].[Id,Name]'
```

確かめたら、次の順に `aws cloudformation delete-stack` で消す。
1. `gekko13-ecs`: ECS のクラスター、サービス、ASG と台、Cloud Map の名前空間、ロググループが消える。
2. `gekko13-cognito`: 利用者と client が消える。
3. `gekko13-network`: VPC と EFS が消える。EFS が消えると、SPIRE の CA と登録も消え、次に作るときは新しい CA になる。
4. `gekko13-registry`: ECR のイメージは、リポジトリと一緒に消える（`EmptyOnDelete`）。

`gekko13-edge` の CloudFront の配信は、スタックを消しても残る。配信を消すと、RP ID が使えなくなり、登録したパスキーも使えなくなる。消すときは、先に配信を無効にしてから、`aws cloudfront delete-distribution` で消す。

`gekko13-edge` のスタック（VPC origin の 4 つ）は、`gekko13-network` より先に消す。CloudFront は、VPC origin のために VPC の中にグループと ENI を作るので、VPC origin が残っていると VPC を消せない（推定）。配信が使っている VPC origin は消せない（[findings 4-9](findings.md#4-9-cloudfront-は配信が使っている-vpc-origin-の更新を拒んだvpc-origin-を-2-組持って切り替えると向け直しは-36-分だった)）ので、配信を先に消すか、配信から外してから消す。

SSM のパラメーター 5 つは、スタックの外で作ったので、`aws ssm delete-parameters` で消す。BFF と transfer の client の秘密、認可サーバーの利用者の代わりの窓口の秘密（`/gekko13/auth/standin-secret`）、リフレッシュトークン、プローブの動かし方（`/gekko13/probe/mode`）の 5 つ。最後に、`list-namespaces` に `svc.gekko13.internal` が残っていないかを確かめる。残っていれば、月額のかかるホストゾーンも残っている（[findings 2-5](findings.md#2-5-作成中に巻き戻すとcloud-map-の名前空間がスタックの外に残った)）。

ローカルは `local/down.sh` で消す。消えるのは、`gekko13=1` のラベルを付けたコンテナ、`gekko13` のネットワークとボリューム、`local/run/` の全部。

## AWS の費用の見込み
単価は東京リージョンの値。EC2 は 2026-11-15 に gekko_12 の設計判断 5 節で、ほかは 2026-11-16 に料金の API で確かめた。

| 部品 | 費用 | いつかかるか |
|---|---|---|
| EC2（t4g.small） | 1 台 1 時間 0.0216 ドル | 台が動いている間 |
| EC2（t4g.medium、C-3） | 1 台 1 時間 0.0432 ドル（料金の API、2026-11-20） | 台が動いている間 |
| Container Insights（C-3） | CloudWatch のメトリクスの従量。数時間なら数セント（推定） | 有効にしている間 |
| EBS（gp3 30 GB） | 1 台あたり月約 2.9 ドルの日割り（推定。gekko_12 の 20 GB で月約 1.9 ドルから比例で出した） | 台がある間。台が 0 なら 0 |
| Cloud Map のホストゾーン | 月 0.5 ドル | ECS のスタックがある間（台が 0 でも） |
| マネージドスケーリングのアラーム（2 つ） | 1 つ月 0.1 ドル | ECS のスタックがある間（台が 0 でも） |
| EFS（Standard） | 1 GB あたり月 0.36 ドル。使うのは数 MB | network のスタックがある間 |
| Cognito の M2M のトークン | 使った分（gekko_12 の実測では 15 件で 0.034 ドル） | 交換と client_credentials のたび |
| ECR、CloudWatch Logs、SSM | ほぼ 0（保存と取り込みの従量。SSM の標準のパラメーターは無料）。ECR は、Keycloak と auth のイメージで約 1 GB 増え、月約 0.1 ドル（推定） | 使った分 |
| CloudFront の配信 | 月の固定費はない。リクエストと転送の従量（試しの分はごく小さい。推定） | 使った分 |
| VPC origin、Egress-only のインターネットゲートウェイ | 追加の料金はない（資料。2026-11-19）。EC2 の転送の従量はかかる | — |

## つまずきやすい点
- **`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`:** Node.js の型の取り除きは `node_modules` の中で動かない。パッケージは相対パスで読む。
- **`aws/deploy.sh` が、テンプレートの検査で止まる:** テンプレートのコメント以外の行に、日本語がある。CloudFormation は、ASCII 以外の文字を「?」に置き換える。Description と Metadata は英語で書き、日本語は `#` のコメントに移す（[findings 2-1](findings.md#2-1-cloudformation-はテンプレートの-ascii-以外の文字をに置き換えた)）。
- **ECS のスタックが `ROLLBACK_COMPLETE` になった:** そのままでは作り直せない。資源が残っていないのを確かめてから消し、作り直す。作成中に巻き戻ったときは、Cloud Map の名前空間がスタックの外に残ることがあるので、`aws servicediscovery list-namespaces` で確かめる（[findings 2-5](findings.md#2-5-作成中に巻き戻すとcloud-map-の名前空間がスタックの外に残った)）。
- **spire-agent のタスクが、止まっては起き直す:** 台を起こした直後の 1 分ほどは、agent が server より先に起き、server に届かずに止まる。server が起きれば安定する。server がいないまま 5 分ほどたつと、agent の SVID が切れて止まり続ける（[findings 3-4](findings.md#3-4-server-が-5-分ほどいないとagent-は自分の-svid-が切れて止まった)）。spire-server のサービスが動いているかを見る。
- **agent が「attestation data has already been used」で止まる:** aws_iid は、同じインスタンスで一度しか確認を通さない。ホストの `/var/lib/gekko13/spire-agent` が消えたときに起きる。台を入れ替える（`scale.sh down` と `up`）。
- **BFF や transfer のトークンの交換が `400 invalid_client` で落ちる:** SSM の client の秘密が、Cognito の値と違う。`aws/deploy.sh` をもう一度実行して入れ直し、bff と transfer を起こし直す（`aws ecs update-service --force-new-deployment`）。ECS は、秘密をタスクの起動のときに読む（[findings 2-7](findings.md#2-7-aws-cli-2381-は標準入力からの値の渡し方の一部で失敗し--output-text-は末尾に改行を付けた)）。
- **実行役が「利用者のトークンを得られない」で止まる:** リフレッシュトークンの有効期限（60 分）が切れた。`node scripts/aws-login.ts` からやり直す。
- **ホストの中を見たい:** IPv6 だけの台は、Session Manager に登録されなかった（[findings 2-11](findings.md#2-11-ipv6-だけの台はsession-manager-に登録されなかった)）。サブネットに IPv4 の経路がないので、公開 IPv4 を付けて入る逃げ道もない（`aws/deploy.sh` は 2 つめの引数を受け付けない）。中の様子は、CloudWatch Logs と ECS の API で見る。
- **`aws/edge-point.sh` が「VPC origin is currently associated」で巻き戻る:** 配信が使っている組を書き換えようとした。スタックのパラメーター（`ActiveSlot`、`InstanceArnA`、`InstanceArnB`）が、手で変えられて食い違っていないかを確かめる（[findings 4-9](findings.md#4-9-cloudfront-は配信が使っている-vpc-origin-の更新を拒んだvpc-origin-を-2-組持って切り替えると向け直しは-36-分だった)）。
