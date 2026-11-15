# 検証の動かし方と後片付け

**この文書の読み手:** この検証を自分で動かす開発者。ローカルでシナリオを回すところから、AWS で作って回し、片付けるまでを扱う。何を確かめるかは [plan.md](plan.md)、判断の理由は [design-decisions.md](design-decisions.md)、用語は [用語集](glossary.md)。

## 要旨
- ローカルは `local/up.sh` で立て、`node scripts/scenarios.ts --target local` で回し、`local/down.sh` で消す。費用はかからない。
- AWS は `aws/deploy.sh` で作り、利用者を作ってログインしてから、`aws/run-scenarios.sh` で回す。
- AWS の手順は、まだ実際には通していない。初めて通すときは、つまずいた点をこの文書と [findings.md](findings.md) に足す。
- 使い終わったら EC2 を止める。止めていても、EBS と ECR の保存の費用は残る。

## 実行前の約束
- AWS に資源を作る前に、持ち主に確かめる。費用は [AWS の費用の見込み](#aws-の費用の見込み) のとおり。
- スタックの削除などの戻しにくい操作は、先に対象を一覧で見せて、承認を得る。
- 秘密、トークン、アカウント ID を、画面の出力やファイルに残さない。手順のスクリプトは、どれも出さないように書いてある。

## 前提
- Node.js 24 以上、docker（buildx を含む）、openssl。`docker compose` は要らない。
- AWS の段では、AWS CLI v2 も要る。
- AWS の段では、東京リージョン（ap-northeast-1）で次の資源を作れる権限が要る。CloudFormation、EC2、ECS、ECR、Cognito、SSM、CloudWatch Logs。
- 依存は `npm ci` で入れる。

## ローカルでの確認
```sh
npm test
```
期待する結果: 型の検査と lint が通り、単体のテストが `11 passed` になる。

## ローカルでシナリオを回す
1. `local/up.sh` を実行する。SVID の有効期限を変えるときは `SVID_TTL=600 local/up.sh` のように渡す（既定は 300 秒）。
2. `ls local/run/svid/*` で、bff、transfer、ledger の各ディレクトリに `svid.pem`、`svid_key.pem`、`svid_bundle.pem` があるのを確かめる。数秒かかる。
3. `node scripts/scenarios.ts --target local` を実行する。
4. 入れ替えの試験は `node scripts/soak.ts --target local --minutes 30` を実行する。

期待する結果: 手順 3 は最後に `11/11 件が期待どおり` と出て、終了コードが 0 になる。手順 4 は `"failed":0` で終わり、各サービスの入れ替えの回数が 10 回以上になる。失敗したときは [つまずきやすい点](#つまずきやすい点) を見る。

## AWS で作る
1. `aws sts get-caller-identity` で、作る先のアカウントが正しいかを確かめる。出力は記録に残さない。
2. `aws/deploy.sh <ドメインの接頭辞>` を実行する。接頭辞は、マネージドログインのドメインになり、リージョンの中で一意にする。IPv6 だけで届かないと分かったときは、2 つめの引数に `true` を渡して、公開 IPv4 を付けて作り直す。
3. 次のコマンドで、インスタンスの登録とサービスの起動を確かめる。

```sh
aws ecs list-container-instances --cluster gekko13 --region ap-northeast-1
aws ecs describe-services --cluster gekko13 --region ap-northeast-1 \
  --services spire-server spire-agent bff transfer ledger \
  --query 'services[].[serviceName,runningCount]' --output table
```

期待する結果: コンテナのインスタンスが 1 つあり、5 つのサービスの `runningCount` がすべて 1 になる。

## AWS でシナリオを回す
1. `aws/create-user.sh` を実行し、検証用の利用者のパスワードを入力する。初回だけでよい。
2. `node scripts/aws-login.ts` を実行し、表示された URL をブラウザで開いて、手順 1 の利用者でログインする。
3. 手順 2 から 60 分のうちに、`aws/run-scenarios.sh` を実行する。リフレッシュトークンの有効期限が 60 分のため。
4. 入れ替えの試験は、もう一度手順 2 でログインしてから `aws/run-scenarios.sh soak 30` を実行する。

期待する結果: 手順 3 は `10/10 件が期待どおり（対象外 1 件）` と出る。対象外は 1-c で、ホストのシェルが要るため AWS では行わない。手順 4 は `"failed":0` で終わる。

## 結果の置き場所
| ファイル | 中身 |
|---|---|
| `local/run/scenarios-local-*.json` | ローカルのシナリオごとの期待と実際 |
| `local/run/soak-local-*.json` | ローカルの入れ替えの試験の件数と、失敗の一覧 |
| `local/run/aws-scenarios-*.log`、`local/run/aws-soak-*.log` | AWS の実行役のログ。`RESULT` の行に JSON の結果、`CLAIMS` の行に本物のトークンの形がある |

`local/run/` は git に入れない。残す結果は、要点を [findings.md](findings.md) と [log.md](log.md) に書き写す。

## 使い終わったら止める
```sh
aws ec2 stop-instances --region ap-northeast-1 --instance-ids <インスタンス ID>
```
インスタンス ID は、`aws/deploy.sh` が最後に出す。もう一度使うときは `start-instances` で起こす。SPIRE の鍵と登録はホストのディスクに残るので、作り直しは要らない。

## 後片付け
スタックは、作った順の逆に消す。消す前に、対象を一覧で確かめる。

```sh
aws cloudformation list-stacks --region ap-northeast-1 \
  --query "StackSummaries[?starts_with(StackName,'gekko13-') && StackStatus!='DELETE_COMPLETE'].StackName"
aws ssm get-parameters-by-path --region ap-northeast-1 --path /gekko13 --recursive --query 'Parameters[].Name'
```

確かめたら、`gekko13-ecs`、`gekko13-cognito`、`gekko13-network`、`gekko13-registry` の順に `aws cloudformation delete-stack` で消す。ECR のイメージは、リポジトリと一緒に消える（`EmptyOnDelete`）。SSM のパラメーター（client の秘密 2 つと、リフレッシュトークン）はスタックの外で作ったので、`aws ssm delete-parameters` で消す。

ローカルは `local/down.sh` で消す。消えるのは、`gekko13=1` のラベルを付けたコンテナ、`gekko13` のネットワークとボリューム、`local/run/` の全部。

## AWS の費用の見込み
単価は東京リージョンの値で、2026-11-15 に確かめた（gekko_12 の設計判断 5 節）。

| 部品 | 費用 | いつかかるか |
|---|---|---|
| EC2（t4g.small） | 1 時間 0.0216 ドル | 動いている間 |
| 公開 IPv4 | 1 時間 0.005 ドル | `true` で作ったときだけ |
| EBS（gp3 30 GB） | 月約 2.9 ドル（推定。gekko_12 の 20 GB で月約 1.9 ドルから比例で出した） | 止めていてもかかる |
| Cognito の M2M のトークン | 使った分（gekko_12 の実測では 15 件で 0.034 ドル） | 交換と client_credentials のたび |
| ECR、CloudWatch Logs、SSM | ほぼ 0（保存と取り込みの従量。SSM の標準のパラメーターは無料） | 使った分 |

## つまずきやすい点
- **`docker compose` がない:** この環境では入れていない。ローカルの環境は `local/up.sh` が `docker run` で立てる。
- **`local/up.sh` が「container name is already in use」で止まる:** 前の環境が残っている。`local/down.sh` で消してから立て直す。`local/up.sh` は、作り直しに対応していない。
- **ローカルで SVID が届かない:** `docker logs gekko13-spire-agent` を見る。join token の有効期限は 600 秒で、agent の起動が遅れると切れる。`local/down.sh` から立て直す。
- **`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`:** Node.js の型の取り除きは `node_modules` の中で動かない。パッケージは相対パスで読む。
- **Cognito のスタックが `ALLOW_TOKEN_EXCHANGE_DELEGATION` で失敗する:** CloudFormation がまだこの値を受け付けていない（未確認の点）。失敗した内容を [findings.md](findings.md) に記録し、持ち主と対処を決める。
- **インスタンスが ECS に登録されない、またはイメージを取れない（`CannotPullContainerError`）:** IPv6 だけでは、ECS や ECR の API に届かない可能性がある。`aws/deploy.sh <接頭辞> true` で、公開 IPv4 を付けて作り直す。
- **agent が「attestation data has already been used」で止まる:** aws_iid は、同じインスタンスで一度しか確認を通さない。ホストの `/var/lib/gekko13/spire-agent` が消えたときに起きる。server の側で `spire-server agent evict` を実行して、古い agent を消す。
- **実行役が「利用者のトークンを得られない」で止まる:** リフレッシュトークンの有効期限（60 分）が切れた。`node scripts/aws-login.ts` からやり直す。
- **3-a が「交換に失敗」で落ちる:** token exchange の設定か、リフレッシュで得たトークンを交換元にできるかの問題。ログの `CLAIMS` の行と、BFF のログ（ストリームの接頭辞 `bff`）を見る。
- **ホストの中を見たい:** `aws ssm start-session --target <インスタンス ID>` で入る（Session Manager のプラグインが要る）。登録の手順の記録は `journalctl -u gekko13-bootstrap` で見る。IPv6 だけでは Session Manager に届かない可能性もある。
