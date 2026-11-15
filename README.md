# gekko_13

ネットバンキングの試作「Gekko Bank」の内部の通信を、SPIFFE の mTLS で守れるかを、ECS on EC2（1 台）の構成で確かめる検証。

**読み手:** この検証に後から加わる開発者と、新しい会話の AI エージェント。AWS と OAuth の基礎は知っている前提。読むと、何が確かめられたかと、自分で回す方法が分かる。

## 答え
- **身元の配り方:** docker の attestor は、ECS と同じ名前のコンテナのラベルで、サービスごとに別の SPIFFE ID を配れた。ローカルで確かめ、AWS では未確認（[findings.md](docs/findings.md#1-spire-の身元の配り方)）。
- **付け替えの防止:** 受け取る側は、mTLS の相手の SPIFFE ID とトークンの `act.client_id` を照合し、乗っ取られたサービスが別のサービスのトークンを使うのを拒めた。トークンの発行者は模擬（[findings.md](docs/findings.md#2-mtls-とトークンの照合)）。
- **入れ替え:** 有効期限 300 秒の SVID を 30 分の間に 13 回入れ替えても、連鎖の呼び出しは失敗しなかった（[findings.md](docs/findings.md#3-svid-の入れ替え)）。

## 読む順番
| 知りたいこと | 読む文書 |
|---|---|
| 何を確かめ、何を合格とするか | [docs/plan.md](docs/plan.md) |
| 確かめた事実と、未確認の点 | [docs/findings.md](docs/findings.md) |
| なぜその作りにしたか | [docs/design-decisions.md](docs/design-decisions.md) |
| 動かし方と後片付け | [docs/runbook.md](docs/runbook.md) |
| いつ何をしたか | [docs/log.md](docs/log.md) |
| 用語の意味 | [docs/glossary.md](docs/glossary.md) |

## 最短の使い方
前提: Node.js 24 以上、docker（buildx を含む）、openssl。

```sh
npm ci
local/up.sh
node scripts/scenarios.ts --target local
local/down.sh
```

期待する結果: シナリオの最後に `11/11 件が期待どおり` と出る。AWS で回す手順は [docs/runbook.md](docs/runbook.md) にある。

## 持ち主と、更新のきっかけ
- **持ち主:** このリポジトリの持ち主。質問はリポジトリの持ち主に送る。
- **更新のきっかけ:** シナリオか合格の基準を変えたら `docs/plan.md`、実機で何かを確かめたら `docs/findings.md` と `docs/log.md`、手順やスクリプトの使い方を変えたら `docs/runbook.md` を直す。
