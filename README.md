# gekko_13

「AI による提案」と「人間による承認」を、当事者の自己申告に依らず第三者が確かめられる形にし、事後の監査に耐えさせる。その仕組みを、AWS の上で安く動かせるかを確かめる検証。題材は、AI が年金保険のプランを組み立て、人間が選んで署名し、保険会社と契約する流れ（gekko_11）。

**読み手:** この検証に後から加わる開発者と、新しい会話の AI エージェント。AWS と OAuth の基礎は知っている前提。読むと、今どこまで確かめたかと、自分で回す方法が分かる。

## 答え
- **基盤（確かめた）:** ECS on EC2 と SPIRE で、ワークロードの身元と mTLS を、インスタンスの数と AZ に依らず作れた。インスタンスを 0 にすれば、費用は月 1 ドル未満の固定費だけになる（推定）。事実は [findings.md](docs/findings.md) の 1〜3 節。
- **第 2 部（途中。段 D の D1-a2）:** gekko_11 の 7 つのサービスを、TypeScript、Java、Python、Go で ECS に載せた。主の流れ（ログインから照合まで）は、CloudFront を通して AWS で通った（[findings 4-37](docs/findings.md#4-37-aws-でも主の流れの-27-段が-cloudfront-を通して通った同時に作った-service-connect-のサービスどうしはタスクを入れ替えるまで互いの名前を引けなかった)）。監査の画面は手元で通り、AWS ではこれから確かめる。そのあと、gekko_11 の 27 のシナリオで手口が止まるかを見る。進め方と合格の基準は [plan.md](docs/plan.md)。
- **第 1 部の文書:** 第 2 部で使い続ける事実と判断は、第 2 部の文書へ移した。第 1 部の文書は消した。読むときは、git の履歴（コミット `0a9b494` の `docs/phase1/`）から読む。

## 読む順番
| 知りたいこと | 読む文書 |
|---|---|
| 何を確かめ、何を合格とするか | [docs/plan.md](docs/plan.md) |
| 確かめた事実と、未確認の点 | [docs/findings.md](docs/findings.md) |
| なぜその作りにしたか | [docs/design-decisions.md](docs/design-decisions.md) |
| 手元と AWS での動かし方と後片付け | [docs/runbook.md](docs/runbook.md) |
| いつ何をしたか | [docs/log.md](docs/log.md) |
| 用語の意味 | [docs/glossary.md](docs/glossary.md) |

## 最短の使い方
前提: Node.js 24 以上、docker（buildx を含む）、openssl、AWS CLI v2。Java、Python、Go の試験とビルドは docker の中で回すので、手元に入れなくてよい。

```sh
npm ci
npm test
```

期待する結果: 型の検査と lint が通り、TypeScript の試験が `76 passed`、Python の試験が `21 passed`、Go の試験が `ok` になる。Java の試験は、イメージのビルドの中で回る。

主の流れを手元で通すときは、`local/up.sh` で全部のサービスを立て、Docker のブラウザで `node scripts/ui-flow.ts` を回す。AWS で作って動かす手順も含めて、[docs/runbook.md](docs/runbook.md) にある。

## 持ち主と、更新のきっかけ
- **持ち主:** このリポジトリの持ち主。質問はリポジトリの持ち主に送る。
- **更新のきっかけ:** シナリオか合格の基準を変えたら `docs/plan.md`、実機で何かを確かめたら `docs/findings.md` と `docs/log.md`、手順やスクリプトの使い方を変えたら `docs/runbook.md` を直す。
