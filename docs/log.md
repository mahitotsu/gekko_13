# 経過の記録

**この文書の読み手:** この検証が、いつ、何をして、何を決めたかを知りたい人。計画と合格の基準は [plan.md](plan.md)、確かめた事実は [findings.md](findings.md)、判断の理由は [design-decisions.md](design-decisions.md)。用語は [用語集](glossary.md)。新しい出来事は、年表の末尾に足す。

## 現在の状況（2026-11-16）
- ローカルの段は、合格の基準（[plan.md の 4 節](plan.md#4-合格の基準)）の (a) を満たした。シナリオ 11 件と入れ替えの試験が、すべて予測どおりだった。
- AWS の段は、registry、network、cognito のスタックを作った。ECS のスタックは、docker が起動せず（[findings 5-3](findings.md#5-3-ip6tables-を書いた-daemonjson-でecs-用の-ami-の-docker-が起動しなかった)）、消した。(b) は未判定。
- 次は、ECS の作りをキャパシティプロバイダーと Service Connect に直してから、作り直す。プローブを Service Connect の下でどう動かすかは、持ち主と決める。

## 年表
| 日付 | 実施 | 結果 | 費用 |
|---|---|---|---|
| 2026-11-15 | gekko_12 の経緯を読み、内部の mTLS を先に確かめると決めた | 計画を書いた | 0 |
| 2026-11-15 | ローカルの環境を `docker run` で立て、シナリオを回した | 11 件すべて予測どおり（[findings 1〜2 節](findings.md#1-spire-の身元の配り方)） | 0 |
| 2026-11-15 | 入れ替えの試験（300 秒の SVID、30 分） | 1,764 回で失敗 0 件、入れ替えは各 13 回（[findings 3-1](findings.md#3-1-30-分の連鎖の呼び出し-1764-回はsvid-の入れ替えを-13-回挟んで失敗-0-件だった)） | 0 |
| 2026-11-15 | AWS の段の CloudFormation、実行役、手順書を書いた | cfn-lint で誤り 0 件。AWS には作っていない | 0 |
| 2026-11-15 | ローカルの後片付け（`local/down.sh`）を試した | 何もない状態で 2 回目を回しても止まらなかった | 0 |
| 2026-11-16 | `aws/deploy.sh` で AWS の段を作り始めた（公開 IPv4 なし） | registry、network、cognito はできた。ECS は、インスタンスが登録されず止まった（[findings 5-3](findings.md#5-3-ip6tables-を書いた-daemonjson-でecs-用の-ami-の-docker-が起動しなかった)） | EC2 が約 30 分で約 0.01 ドル（推定） |
| 2026-11-16 | 持ち主の承認を得て、gekko13-ecs のスタックを消した | 消えた。ほかのスタックと SSM のパラメーターは残した | 0 |
| 2026-11-16 | スタックの説明が「?」に化けているのを、持ち主が見つけた | CloudFormation の側の置き換えと分かった。4 つのテンプレートの説明と Metadata を英語にし、3 つのスタックを更新した（[findings 5-1](findings.md#5-1-cloudformation-はテンプレートの-ascii-以外の文字をに置き換えた)） | 0 |

## 決めたこと
- 2026-11-15: ローカルの環境を、`docker compose` ではなく `docker run` で立てる。この環境に compose がなく、ECS も compose を使わないため。持ち主が承認した。
- 2026-11-15: Dockerfile から `RUN` をなくし、依存はホストで入れて写す。arm64 のエミュレーションがないため（[findings 4-4](findings.md#4-4-run-のない-dockerfile-ならエミュレーションなしで-arm64-のイメージを作れた)）。
- 2026-11-15: トークンの照合のコードは、gekko_12 の実測に合わせて `act.client_id` を見る。ドキュメントの例とは食い違うので、AWS の段で決め直す（[findings 4-2](findings.md#4-2-委任のトークンの形はドキュメントの例と-gekko_12-の実測で食い違う)）。
- 2026-11-15: 入れ替えの試験の予測「各サービスで 10 回以上入れ替わる」は、試験を回している間に、結果を見る前に計画へ書き足した。300 秒の SVID が半分の時間で入れ替わるという見込みから出した。
- 2026-11-15: シナリオ 1-c（ホストで `docker run`）は、AWS では行わない。ホストのシェルが要るため。合否の基準にはもともと入れていない。
- 2026-11-16: 持ち主が AWS に資源を作るのを承認した。
- 2026-11-16: ECS の作りを、スケールアウトしても壊れない形に直す。持ち主の指摘による。今の作りは、サービス間の呼び出し、agent から server への接続、SPIRE server の状態、登録の手順が、1 台を前提にしている。直し方は次の 4 つで、持ち主が承認した。
  - キャパシティプロバイダー（マネージドスケーリング）
  - アプリどうしの Service Connect（TCP の中継だけ）
  - Cloud Map の DNS で見つける、awsvpc の SPIRE server
  - EFS に置く、server の状態

  設計の判断は、作り終えてから [design-decisions.md](design-decisions.md) に書く。
- 2026-11-16: 持ち主が、月に約 0.7 ドルの固定費を承認した（推定。Cloud Map のホストゾーンが 0.5 ドル、マネージドスケーリングのアラーム 2 つが約 0.2 ドル、EFS はほぼ 0）。
- 2026-11-16: AWS の段を 2 つに分ける。段 A は 1 AZ で、各サービス 1 タスク。段 B はマルチ AZ で、複数タスクのサービス。段 B の確かめる項目と合格の基準は、結果を見る前に [plan.md](plan.md) に足す。
- 2026-11-16: CloudFormation のテンプレートの説明と Metadata は、英語で書く（[findings 5-1](findings.md#5-1-cloudformation-はテンプレートの-ascii-以外の文字をに置き換えた)）。
- 2026-11-16: この環境に cfn-lint が入っていなかったので、テンプレートの検査は `aws cloudformation validate-template` で行った。

## 次の候補（未実施）
- AWS の段を通す（[runbook.md](runbook.md#aws-で作る)）。[findings の 6 節](findings.md#6-未確認) の未確認の点が、ここで決まる。
- 入口（CloudFront から BFF まで）の区間をどう守るかを決める。
- データベースへの経路の線引き（SPIFFE の mTLS の範囲と、AWS の TLS と IAM に任せる範囲）を決める。
- account と enroll のサービスを足し、gekko_12 の要件を書き直す。
