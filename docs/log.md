# 経過の記録

**この文書の読み手:** この検証が、いつ、何をして、何を決めたかを知りたい人。計画と合格の基準は [plan.md](plan.md)、確かめた事実は [findings.md](findings.md)、判断の理由は [design-decisions.md](design-decisions.md)。用語は [用語集](glossary.md)。新しい出来事は、年表の末尾に足す。

## 現在の状況（2026-11-20）
- 第 2 部を始めた。題材は、gekko_11 の年金保険の申込みの流れで、これを第 1 部の基盤（ECS on EC2、SPIRE、IPv6 だけ）の上で動かす。
- 第 2 部の計画（[plan.md](plan.md)）を書いた。段 C の C-1 は予測どおりだった。CloudFront から、IPv6 だけの台の上のサービスに届いた（[findings 4-1](findings.md#4-1-cloudfront-は送り先の-ip-の種類を-ipv6-にするとipv6-だけの台に届いた既定の-ipv4-では届かなかった)）。
- C-4 も予測どおりだった。Spring Authorization Server は、Envoy なしで SVID の mTLS を終えた。交換したトークンは、呼び手の SVID の証明書に結ばれた（[findings 4-4](findings.md#4-4-spring-authorization-server-はenvoy-なしで-svid-の-mtls-を自分で終え交換したトークンを呼び手の-svid-の証明書に結んだ)）。
- C-2 と C-1b も予測どおりだった。入口を VPC origin に替え、台をプライベートのサブネットに移した（[findings 4-8](findings.md#4-8-cloudfront-はプライベートのサブネットの台に-vpc-origin-で届きパスで-2-つの受け口に振り分けた台から見た送り主はcloudfront-の公開-ipv4-だった)）。配信の名前を RP ID にして、パスキーの登録と署名ができた（[4-10](findings.md#4-10-配信の既定のドメインを-rp-id-にしてパスキーを登録し別のパスの受け口で文書のハッシュに署名できたcloudfrontnet-は-rp-id-にできなかった)）。
- C-3 の準備をした。Keycloak と認可サーバー（auth）を AWS に載せる作りと、測るスクリプト（`aws/c3-measure.sh`）を足した。AWS ではまだ測っていない。測る前に、持ち主に確かめる。
- AWS のスタックは、第 1 部の 4 つに、CloudFront の `gekko13-edge` を足して 5 つ。台は 0 台。AWS の今の作りは、第 1 部のアプリと、確認用のサービス（edge-check）を載せたまま。C-3 の作りは、まだ AWS に送っていない。入口は VPC origin（A の組が使われている）。

## 年表
| 日付 | 実施 | 結果 | 費用 |
|---|---|---|---|
| 2026-11-18 | 第 1 部の文書を `docs/phase1/` に仮置きし、第 2 部で使い続ける事実と判断を、第 2 部の findings、design-decisions、runbook へ移した | 移した事実は findings の 1〜3 節、判断は design-decisions の最初の 15 行 | 0 |
| 2026-11-18 | 第 2 部の計画を書いた | 段 C（4 件）、段 D（27 のシナリオを D1 と D2 に分ける）、段 E（後回し） | 0 |
| 2026-11-18 | C-1 の準備をした（確認用のサービス、CloudFront の配信、edge-point.sh） | コミット `cac117d` | 0 |
| 2026-11-18 | 基盤を更新した（deploy.sh） | ECS のスタックの更新が、spire-server の置き方の制約の残りで止まった（[findings 2-9](findings.md#2-9-cloudformation-はテンプレートに書いていない項目を外から変えても戻さなかった)）。止まりを解こうとして新しいデプロイを強制し、更新が失敗して巻き戻った（[2-10](findings.md#2-10-cloudformation-が更新しているサービスに新しいデプロイを強制するとスタックの更新が失敗して巻き戻った)）。直しをコミットして（`0a9b494`）、回し直すと通った | — |
| 2026-11-18 | C-1a: CloudFront の送り先を、台の IPv6 の名前にした | 既定の IP の種類（ipv4）では 502。持ち主の指摘で `ipv6` にすると届いた（[findings 4-1](findings.md#4-1-cloudfront-は送り先の-ip-の種類を-ipv6-にするとipv6-だけの台に届いた既定の-ipv4-では届かなかった)） | — |
| 2026-11-18 | C-1c: 台を入れ替えて、送り先を向け直した | 向け直してから約 100 秒で届いた。入れ替えた台の 1 つで、IPv6 のポートが拒まれた。原因は分からない（[findings 4-2](findings.md#4-2-台が入れ替わると送り先を向け直すまで届かず向け直してから約-100-秒で届いた)、[4-3](findings.md#4-3-ある台でipv6-で公開したポートがある時間だけ拒まれた原因は分からない)）。そのあと台を 0 にした | EC2 が 2 台で約 1 時間 40 分、約 0.07 ドル（推定）。CloudFront はごく小さい（推定） |
| 2026-11-19 | C-4: ローカルで、最小の認可サーバー（`services/auth`）を立て、`scripts/c4-check.ts` で判定した | 1 回目は 6/7。交換（C4-5）が、元のトークンの保存に利用者がなくて拒まれた（[findings 4-5](findings.md#4-5-spring-authorization-server-の交換は元のトークンの保存に利用者がないと説明なしの-invalid_grant-で拒んだ)）。直して 7/7 | 0 |
| 2026-11-19 | SVID の入れ替わりで、鍵も替わるかを確かめた | 3 回とも鍵が替わった。公開鍵に結ぶ方法でも、入れ替わりのあとは使えない（[findings 4-7](findings.md#4-7-spire-はsvid-を入れ替えるたびに鍵の組も新しく作った)） | 0 |
| 2026-11-19 | C-1b: サブネットをプライベートにし（EIGW、IGW への経路なし）、入口を VPC origin に替えた（`aws/deploy.sh`、`aws/edge-point.sh`） | 届いた。最初の作りで 596 秒。台から見た送り主は、予測（VPC の IPv4）と違い、CloudFront の公開 IPv4 だった（[findings 4-8](findings.md#4-8-cloudfront-はプライベートのサブネットの台に-vpc-origin-で届きパスで-2-つの受け口に振り分けた台から見た送り主はcloudfront-の公開-ipv4-だった)） | — |
| 2026-11-19 | C-2: 持ち主が、Windows の Edge と Windows Hello で、パスキーの登録と署名を試した | 4 件とも合格（[findings 4-10](findings.md#4-10-配信の既定のドメインを-rp-id-にしてパスキーを登録し別のパスの受け口で文書のハッシュに署名できたcloudfrontnet-は-rp-id-にできなかった)） | — |
| 2026-11-19〜20 | B4: 台を入れ替えて、VPC origin を向け直した | 1 回目は、CloudFront が 409 で拒み、スタックが巻き戻った。VPC origin を A と B の 2 組にして、192 秒と 348 秒で届いた（[findings 4-9](findings.md#4-9-cloudfront-は配信が使っている-vpc-origin-の更新を拒んだvpc-origin-を-2-組持って切り替えると向け直しは-36-分だった)）。そのあと台を 0 にした | EC2 が 2 台で約 1 時間 20 分、約 0.06 ドル（推定）。CloudFront はごく小さい（推定） |
| 2026-11-20 | C-3 の準備をした（`services/keycloak`、ECS の auth と keycloak、`aws/c3-measure.sh`）。ローカルで Keycloak のイメージを試した | Keycloak は `start --optimized` と dev-file で起き、x86 の機械で、起動から discovery が返るまで 27 秒、メモリは上限 1 GiB の下で約 675 MiB だった。arm64 のイメージは、エミュレーションなしで作れた | 0 |

## 決めたこと
- 2026-11-18: 持ち主の目的を、検証の軸にする。「AI による提案」と「人間による承認」を、当事者の自己申告に依らず第三者が認証でき、事後の監査に耐えるようにする。
- 2026-11-18: 題材は、gekko_11 の年金保険の申込みの流れにする。gekko_11 の要件、シナリオ、防御は、gekko_11 の番号で引き、内容は写さない。
- 2026-11-18: ログインサーバーと認可サーバーは、gekko_11 と同じく Keycloak と Spring Authorization Server にする。どちらも ECS の上で動かす。持ち主が承認した。
- 2026-11-18: gekko_13 の続きとして、第 2 部に丸ごと入れ替える。第 2 部が完成したら、第 1 部の文書と、第 2 部に引き継がなかったコードを消す。持ち主の方針。
- 2026-11-18: パスキーの RP ID は、CloudFront の既定のドメインにする。持ち主が承認した。
- 2026-11-18: 第 2 部の合格の基準は、(a) から振り直す。第 1 部の基準 (a)〜(d) とは別の文書のため。
- 2026-11-18: C-1a で届いたので、C-1b（VPC origin。サブネットをプライベートにする）は行わない。
- 2026-11-18: 入口の経路（CloudFront から台の公開 IPv6 へ、AAAA だけの名前で）を、design-decisions に「提案」として書いた。送り先の名前に第三者の DNS（sslip.io）を使うかは、段 D で持ち主と決める。
- 2026-11-19: 段 C の順を、C-4（ローカル）、C-2 と C-1b（AWS で一度に）、C-3 にした。入口は、第三者の DNS に頼らない VPC origin に替える方向で、C-1b で確かめる（2026-11-18 の「C-1b は行わない」を改める）。持ち主が承認した。
- 2026-11-19: C-4 の認可サーバーは、java-spiffe を使わず、spiffe-helper の PEM を Spring Boot の SSL バンドルで読む。plan.md の予測の「java-spiffe など」の範囲なので、基準は変えない。
- 2026-11-19: 入口を VPC origin にする。台を入れ替えたときの向け直しは、VPC origin の A と B の 2 組を切り替える形にする（計画で決めておいた代わりの形）。sslip.io の入口は廃止した。
- 2026-11-19: サブネットに IPv4 の経路がなくなったので、`aws/deploy.sh` の公開 IPv4 の引数を止めた。- 2026-11-20: C-3 の「台を起こしてから使えるまで」を、測る前に次のとおりに定めた。plan.md の基準（10 分以内）は変えず、測り方を明らかにしたもの。持ち主が承認した。
  - 始点: 台が 0 の状態で、サービスのタスク数を戻した時刻。
  - 終点: CloudFront を通して Keycloak のレルムの discovery が配信の名前を issuer にして返り、かつ auth のログに起動の完了が出た時刻。VPC origin の向け直しも含める（0 台から起こすと、いつも新しい台になるため）。
  - 判定: 3 回測り、3 回とも 600 秒以内なら予測どおり。台は t4g.medium の 1 台（`GEKKO13_MAX_HOSTS=1`）。30 分置いて、メモリの不足で止まったタスクがないことも見る。
- 2026-11-20: C-3 では、Keycloak の保存先を使い捨て（dev-file）にする。CloudFront の `/login/*`（台の 8081）は Keycloak に充てる（[design-decisions](design-decisions.md)）。C-2 のパスキーの試しの画面は使えなくなる。持ち主が承認した。

## 次の候補（未実施）
- 持ち主に確かめてから、C-3 を AWS で測る（[runbook の C-3 の節](runbook.md#段-c-の-c-3-を測る)）。結果は findings の 4-11 に書く。
- 段 C の結果を見て、段 D の作り（アプリの入れ替え）を計画する。
