# 検証の動かし方と後片付け

**この文書の読み手:** この検証を自分で動かす開発者。ローカルでシナリオを回すところから、AWS で作って回し、片付けるまでを扱う。何を確かめるかは [plan.md](plan.md)、判断の理由は [design-decisions.md](design-decisions.md)、用語は [用語集](../glossary.md)。

**仮置き:** これは第 1 部（内部の mTLS の基盤）の文書で、第 2 部が完成したら消す。第 2 部で要る事実と判断は、第 2 部の文書へ移す。

## 要旨
- ローカルは `local/up.sh` で立て、`node scripts/scenarios.ts --target local` で回し、`local/down.sh` で消す。費用はかからない。
- AWS は `aws/deploy.sh` で作り、`aws/scale.sh up` で台を起こし、ログインしてから `aws/run-scenarios.sh` で回す。
- 使い終わったら `aws/scale.sh down` で、タスクと台を 0 にする。スタックは残し、次は `scale.sh up` から始められる。
- 台が 0 の間も、月額の固定費（ホストゾーンとアラーム）と、保存の費用は残る（[AWS の費用の見込み](#aws-の費用の見込み)）。

## 実行前の約束
第 2 部の [runbook](../runbook.md#実行前の約束) へ移した。

## 前提
第 2 部の [runbook](../runbook.md#前提) へ移した。

## ローカルでの確認
第 2 部の [runbook](../runbook.md#ローカルでの確認) へ移した。

## ローカルでシナリオを回す
1. `local/up.sh` を実行する。SVID の有効期限を変えるときは `SVID_TTL=600 local/up.sh` のように渡す（既定は 300 秒）。
2. `ls local/run/svid/*` で、bff、transfer、ledger の各ディレクトリに `svid.pem`、`svid_key.pem`、`svid_bundle.pem` があるのを確かめる。数秒かかる。
3. `node scripts/scenarios.ts --target local` を実行する。
4. 入れ替えの試験は `node scripts/soak.ts --target local --minutes 30` を実行する。
5. 終わったら `local/down.sh` で消す。`local/run/` も全部消えるので、残したい結果は先に写す。

期待する結果: 手順 3 は最後に `11/11 件が期待どおり（対象外 0 件）` と出て、終了コードが 0 になる。手順 4 は `"failed":0` で終わり、各サービスの入れ替えの回数が 10 回以上になる。失敗したときは [つまずきやすい点](#つまずきやすい点) を見る。

## AWS で作る
第 2 部の [runbook](../runbook.md#aws-で作る) へ移した。

## 台を起こす・0 にする
第 2 部の [runbook](../runbook.md#台を起こす0-にする) へ移した。

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

手順 5 で付けた制約は、新しい server が動いたあとに、実行役が外す。制約は次にタスクを置くときだけに効くので、外しても server はもう一度は入れ替わらない。`aws/deploy.sh` も、更新の前に制約が残っていれば外す。段 A に戻すときは、環境変数を付けずに `aws/deploy.sh <ドメインの接頭辞>` を実行する。

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
第 2 部の [runbook](../runbook.md#後片付け) へ移した。

## AWS の費用の見込み
第 2 部の [runbook](../runbook.md#aws-の費用の見込み) へ移した。

## つまずきやすい点
基盤に関わるものは、第 2 部の [runbook](../runbook.md#つまずきやすい点) へ移した。ここには、第 1 部のローカルの環境とシナリオのものを残す。
- **`docker compose` がない:** この環境では入れていない。ローカルの環境は `local/up.sh` が `docker run` で立てる。
- **`local/up.sh` が「container name is already in use」で止まる:** 前の環境が残っている。`local/down.sh` で消してから立て直す。`local/up.sh` は、作り直しに対応していない。
- **ローカルで SVID が届かない:** `docker logs gekko13-spire-agent` を見る。join token の有効期限は 600 秒で、agent の起動が遅れると切れる。`local/down.sh` から立て直す。
- **入れ替えの試験の途中で、PC がスリープした:** 試験そのものは AWS の上で最後まで走るが、結果のまとめと、プローブを 0 に戻す処理は PC の上で動く。復帰が遅れると「時間内に終わらなかった」で止まる。その場合も `aws/scale.sh down` を実行して、プローブと台を 0 にする。試験のログは CloudWatch Logs に残る。