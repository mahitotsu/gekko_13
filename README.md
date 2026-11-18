# gekko_13

「AI による提案」と「人間による承認」を、当事者の自己申告に依らず第三者が確かめられる形にし、事後の監査に耐えさせる。その仕組みを、AWS の上で安く動かせるかを確かめる検証。題材は、AI が年金保険のプランを組み立て、人間が選んで署名し、保険会社と契約する流れ（gekko_11）。

**読み手:** この検証に後から加わる開発者と、新しい会話の AI エージェント。AWS と OAuth の基礎は知っている前提。読むと、今どこまで確かめたかと、自分で回す方法が分かる。

## 答え
- **基盤（確かめた）:** ECS on EC2 と SPIRE で、ワークロードの身元と mTLS を、台の数と AZ に依らず作れた。台を 0 にすれば、費用は月 1 ドル未満の固定費だけになる（推定）。事実は [findings.md](docs/findings.md) の 1〜3 節。
- **第 2 部（これから）:** gekko_11 が手元のクラスタで満たした 12 の要件を、この基盤の上でも満たせるか。進め方と合格の基準は [plan.md](docs/plan.md)。
- **第 1 部の報告書:** 基盤を確かめた第 1 部の結論は [docs/phase1/report.md](docs/phase1/report.md) にある。第 1 部の文書は仮置きで、第 2 部が完成したら消す。

## 読む順番
| 知りたいこと | 読む文書 |
|---|---|
| 何を確かめ、何を合格とするか | [docs/plan.md](docs/plan.md) |
| 確かめた事実と、未確認の点 | [docs/findings.md](docs/findings.md) |
| なぜその作りにしたか | [docs/design-decisions.md](docs/design-decisions.md) |
| 基盤の動かし方と後片付け | [docs/runbook.md](docs/runbook.md) |
| いつ何をしたか | [docs/log.md](docs/log.md) |
| 用語の意味 | [docs/glossary.md](docs/glossary.md) |

## 最短の使い方
前提: Node.js 24 以上、docker（buildx を含む）、openssl、AWS CLI v2。

```sh
npm ci
npm test
```

期待する結果: 型の検査と lint が通り、単体のテストが `11 passed` になる。AWS の基盤を作って動かす手順は [docs/runbook.md](docs/runbook.md) にある。今のアプリは第 1 部のもので、第 2 部の段 D で入れ替える。

## 持ち主と、更新のきっかけ
- **持ち主:** このリポジトリの持ち主。質問はリポジトリの持ち主に送る。
- **更新のきっかけ:** シナリオか合格の基準を変えたら `docs/plan.md`、実機で何かを確かめたら `docs/findings.md` と `docs/log.md`、手順やスクリプトの使い方を変えたら `docs/runbook.md` を直す。
