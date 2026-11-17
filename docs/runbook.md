# 検証の動かし方と後片付け

**この文書の読み手:** この検証を自分で動かす開発者。ローカルでシナリオを回すところから、AWS で作って回し、片付けるまでを扱う。何を確かめるかは [plan.md](plan.md)、判断の理由は [design-decisions.md](design-decisions.md)、用語は [用語集](glossary.md)。

## 要旨
- ローカルは `local/up.sh` で立て、`node scripts/scenarios.ts --target local` で回し、`local/down.sh` で消す。費用はかからない。
- AWS は `aws/deploy.sh` で作り、`aws/scale.sh up` で台を起こし、ログインしてから `aws/run-scenarios.sh` で回す。
- 使い終わったら `aws/scale.sh down` で、タスクと台を 0 にする。スタックは残し、次は `scale.sh up` から始められる。
- 台が 0 の間も、月額の固定費（ホストゾーンとアラーム）と、保存の費用は残る（[AWS の費用の見込み](#aws-の費用の見込み)）。

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
期待する結果: 型の検査と lint が通り、単体のテストが `11 passed` になる。続けて、CloudFormation のテンプレートの検査（`scripts/check-templates.sh`）が、何も出さずに通る。

## ローカルでシナリオを回す
1. `local/up.sh` を実行する。SVID の有効期限を変えるときは `SVID_TTL=600 local/up.sh` のように渡す（既定は 300 秒）。
2. `ls local/run/svid/*` で、bff、transfer、ledger の各ディレクトリに `svid.pem`、`svid_key.pem`、`svid_bundle.pem` があるのを確かめる。数秒かかる。
3. `node scripts/scenarios.ts --target local` を実行する。
4. 入れ替えの試験は `node scripts/soak.ts --target local --minutes 30` を実行する。
5. 終わったら `local/down.sh` で消す。`local/run/` も全部消えるので、残したい結果は先に写す。

期待する結果: 手順 3 は最後に `11/11 件が期待どおり（対象外 0 件）` と出て、終了コードが 0 になる。手順 4 は `"failed":0` で終わり、各サービスの入れ替えの回数が 10 回以上になる。失敗したときは [つまずきやすい点](#つまずきやすい点) を見る。

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

期待する結果: 最後に `作った。使い終わったら aws/scale.sh down で、タスクと台を 0 にする` と出る。作った直後は、キャパシティプロバイダーが台を起こし、SPIRE server、bff、transfer、ledger が 1 タスクずつ（段 B は 2 タスクずつ）動いている。プローブの 3 つのサービス（probe-bff、probe-transfer、probe-ledger）は、タスク数 0 のままになる。

## 台を起こす・0 にする
```sh
aws/scale.sh up      # SPIRE server を 1、bff、transfer、ledger を 1（引数で数を変えられる）にして、安定するまで待つ
aws/scale.sh down    # タスクを 0 にし、ASG の希望台数も 0 にして、台が 0 になるまで待つ
```

期待する結果: `up` は数分で `安定した（台 2 台）` のように出る。0 台から起こすと、1 台で足りても 2 台が起きることがある（[findings 6-2](findings.md#6-2-0-台から起こすときマネージドスケーリングは-2-台を起こした)）。`down` は約 3 分で `台が 0 になった` と出る。SPIRE の CA と登録は EFS に残るので、`up` のあとも作り直しは要らない（[findings 6-3](findings.md#6-3-台を-0-にして起こし直してもefs-の上の-spire-の-ca-と登録は残った)）。

## AWS でシナリオを回す
手順 1 と 2 は、パスワードの入力とブラウザが要るので、自分の端末で実行する。手順 1 は初回だけでよい。

1. `aws/create-user.sh` を実行し、検証用の利用者 `demo-user` のパスワードを入力する（16 文字以上、大文字、小文字、数字を含む）。複数の行をまとめて貼り付けない。2 行目がパスワードとして読まれる。
2. `node scripts/aws-login.ts` を実行し、表示された URL をブラウザで開いて、手順 1 の利用者でログインする。
3. 手順 2 から 60 分のうちに、`aws/run-scenarios.sh` を実行する。リフレッシュトークンの有効期限が 60 分のため。
4. 入れ替えの試験は、`aws/run-scenarios.sh soak 30` を実行する。約 35 分かかる。その間、手元の PC をスリープにしない（[つまずきやすい点](#つまずきやすい点)）。

期待する結果:
- 手順 1 は `利用者 demo-user を作った。次は node scripts/aws-login.ts` と出る。
- 手順 2 は `リフレッシュトークンを /gekko13/probe/refresh-token に置いた。` と出る。
- 手順 3 は、`probe-bff`、`probe-transfer`、`probe-ledger` がそれぞれ `終わった（0）` と出たあと、`10/10 件が期待どおり（対象外 1 件）。` と出る。対象外は 1-c で、ホストのシェルが要るため AWS では行わない。最後に `プローブのタスク数を 0 に戻した` と出る。
- 手順 4 は `失敗 0 件。入れ替え bff … 回、transfer … 回、ledger … 回（10 回以上が基準）。` と出る。

## 段 B を回す
段 B は、2 つの AZ に台を置き、bff、transfer、ledger を各 2 タスクにして、段 A と同じ試験と、SPIRE server の入れ替え（B-4）を回す。ケースと予測は [plan.md の 4 節](plan.md#4-段-b-のケースと予測)。台は最大 4 台で、1 時間あたり最大約 0.09 ドル。全体で 1 時間半ほどかかる（推定）。

1. 変更をコミットしてから、段 B の作りにする。スタックの更新で、ASG のサブネットと上限、サービスのタスク数が変わる。

```sh
GEKKO13_AZS=2 GEKKO13_TASKS=2 GEKKO13_MAX_HOSTS=4 aws/deploy.sh <ドメインの接頭辞>
aws/scale.sh up 2
```

2. `node scripts/aws-login.ts` でログインする。ここから 60 分のうちに、手順 3〜5 を終える。
3. `aws/run-scenarios.sh` を実行する（B-1、B-2）。
4. `aws/run-scenarios.sh soak 30` を実行する（B-3）。
5. ログインし直してから、`FAILOVER_AFTER=3 aws/run-scenarios.sh failover 12` を実行する（B-4。約 15 分）。始めて 3 分後に、SPIRE server のサービスへ「今の AZ 以外に置く」制約を付け、新しいデプロイを強制して、server を移す。別の AZ に台がなければ、今の台以外に移す。移したあとに、SVID の有効期限（5 分）を超えて 9 分見る。
6. `aws/scale.sh down` で台を 0 にする。

期待する結果:
- 手順 3 は、段 A の 10 件に B-1 を加えて `11/11 件が期待どおり（対象外 1 件）。` と出る。B-1 の行に、サービスごとのタスクの AZ が出る。
- 手順 4 は、`入れ替え bff … 回（2 タスクの最少）` のように、タスクの中で一番少ない回数が出る。
- 手順 5 は、`PASS B-4` の行に、移し先の AZ、CA の識別子の前と後、server がいなかった時間、止まった agent の数、連鎖の失敗の数が出る。

手順 5 で付けた制約は外さずに残る。外すと、もう一度 server が入れ替わるため。次に `aws/deploy.sh` を実行すると、テンプレートの値（制約なし）に戻る。段 A に戻すときは、環境変数を付けずに `aws/deploy.sh <ドメインの接頭辞>` を実行する。

## 結果の置き場所
| ファイル | 中身 |
|---|---|
| `local/run/scenarios-local-*.json`、`local/run/soak-local-*.json` | ローカルのシナリオと入れ替えの試験の結果 |
| `local/run/aws-scenarios-<時刻>/`、`local/run/aws-soak-<時刻>/` | AWS のプローブの 3 つの役と rogue のログ。`CLAIMS` の行に、本物のトークンの形がある |
| `local/run/scenarios-aws-*.json`、`local/run/soak-aws-*.json`、`local/run/failover-aws-*.json` | `scripts/aws-collect.ts` がまとめた AWS の結果 |
| `local/run/aws-scenarios-<時刻>/placement.txt` | タスクの置き場所（サービス、タスク、AZ、台） |
| `local/run/aws-failover-<時刻>/` | server の入れ替えの記録（`failover.txt`）、新旧の server と registrar のログ、止まった agent の一覧 |

`local/run/` は git に入れない。`local/down.sh` は `local/run/` を全部消すので、AWS の結果も一緒に消える。残す結果は、要点を [findings.md](findings.md) と [log.md](log.md) に書き写す。

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

SSM のパラメーター 4 つは、スタックの外で作ったので、`aws ssm delete-parameters` で消す。BFF と transfer の client の秘密、リフレッシュトークン、プローブの動かし方（`/gekko13/probe/mode`）の 4 つ。最後に、`list-namespaces` に `svc.gekko13.internal` が残っていないかを確かめる。残っていれば、月額のかかるホストゾーンも残っている（[findings 5-6](findings.md#5-6-作成中に巻き戻すとcloud-map-の名前空間がスタックの外に残った)）。

ローカルは `local/down.sh` で消す。消えるのは、`gekko13=1` のラベルを付けたコンテナ、`gekko13` のネットワークとボリューム、`local/run/` の全部。

## AWS の費用の見込み
単価は東京リージョンの値。EC2 は 2026-11-15 に gekko_12 の設計判断 5 節で、ほかは 2026-11-16 に料金の API で確かめた。

| 部品 | 費用 | いつかかるか |
|---|---|---|
| EC2（t4g.small） | 1 台 1 時間 0.0216 ドル | 台が動いている間 |
| EBS（gp3 30 GB） | 1 台あたり月約 2.9 ドルの日割り（推定。gekko_12 の 20 GB で月約 1.9 ドルから比例で出した） | 台がある間。台が 0 なら 0 |
| 公開 IPv4 | 1 台 1 時間 0.005 ドル | `aws/deploy.sh` の 2 つめの引数を `true` にしたときだけ |
| Cloud Map のホストゾーン | 月 0.5 ドル | ECS のスタックがある間（台が 0 でも） |
| マネージドスケーリングのアラーム（2 つ） | 1 つ月 0.1 ドル | ECS のスタックがある間（台が 0 でも） |
| EFS（Standard） | 1 GB あたり月 0.36 ドル。使うのは数 MB | network のスタックがある間 |
| Cognito の M2M のトークン | 使った分（gekko_12 の実測では 15 件で 0.034 ドル） | 交換と client_credentials のたび |
| ECR、CloudWatch Logs、SSM | ほぼ 0（保存と取り込みの従量。SSM の標準のパラメーターは無料） | 使った分 |

## つまずきやすい点
- **`docker compose` がない:** この環境では入れていない。ローカルの環境は `local/up.sh` が `docker run` で立てる。
- **`local/up.sh` が「container name is already in use」で止まる:** 前の環境が残っている。`local/down.sh` で消してから立て直す。`local/up.sh` は、作り直しに対応していない。
- **ローカルで SVID が届かない:** `docker logs gekko13-spire-agent` を見る。join token の有効期限は 600 秒で、agent の起動が遅れると切れる。`local/down.sh` から立て直す。
- **`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`:** Node.js の型の取り除きは `node_modules` の中で動かない。パッケージは相対パスで読む。
- **`aws/deploy.sh` が、テンプレートの検査で止まる:** テンプレートのコメント以外の行に、日本語がある。CloudFormation は、ASCII 以外の文字を「?」に置き換える。Description と Metadata は英語で書き、日本語は `#` のコメントに移す（[findings 5-1](findings.md#5-1-cloudformation-はテンプレートの-ascii-以外の文字をに置き換えた)）。
- **ECS のスタックが `ROLLBACK_COMPLETE` になった:** そのままでは作り直せない。資源が残っていないのを確かめてから消し、作り直す。作成中に巻き戻ったときは、Cloud Map の名前空間がスタックの外に残ることがあるので、`aws servicediscovery list-namespaces` で確かめる（[findings 5-6](findings.md#5-6-作成中に巻き戻すとcloud-map-の名前空間がスタックの外に残った)）。
- **spire-agent のタスクが、止まっては起き直す:** 台を起こした直後の 1 分ほどは、agent が server より先に起き、server に届かずに止まる。server が起きれば安定する。server がいないまま 5 分ほどたつと、agent の SVID が切れて止まり続ける（[findings 6-5](findings.md#6-5-server-が-5-分ほどいないとagent-は自分の-svid-が切れて止まった)）。spire-server のサービスが動いているかを見る。
- **agent が「attestation data has already been used」で止まる:** aws_iid は、同じインスタンスで一度しか確認を通さない。ホストの `/var/lib/gekko13/spire-agent` が消えたときに起きる。台を入れ替える（`scale.sh down` と `up`）。
- **3-a が `400 invalid_client` で落ちる:** SSM の client の秘密が、Cognito の値と違う。`aws/deploy.sh` をもう一度実行して入れ直し、bff と transfer を起こし直す（`aws ecs update-service --force-new-deployment`）。ECS は、秘密をタスクの起動のときに読む（[findings 5-8](findings.md#5-8-aws-cli-2381-は標準入力からの値の渡し方の一部で失敗し--output-text-は末尾に改行を付けた)）。
- **実行役が「利用者のトークンを得られない」で止まる:** リフレッシュトークンの有効期限（60 分）が切れた。`node scripts/aws-login.ts` からやり直す。
- **入れ替えの試験の途中で、PC がスリープした:** 試験そのものは AWS の上で最後まで走るが、結果のまとめと、プローブを 0 に戻す処理は PC の上で動く。復帰が遅れると「時間内に終わらなかった」で止まる。その場合も `aws/scale.sh down` を実行して、プローブと台を 0 にする。試験のログは CloudWatch Logs に残る。
- **ホストの中を見たい:** `aws ssm start-session --target <インスタンス ID>` で入る（Session Manager のプラグインが要る）。IPv6 だけで Session Manager に届くかは、確かめていない。届かなければ、作業の間だけ `aws/deploy.sh <接頭辞> true` で公開 IPv4 を付ける。
