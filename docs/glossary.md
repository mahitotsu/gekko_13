# 用語集

**この文書の読み手:** この検証の文書を読んでいて、SPIFFE、SPIRE、token exchange の用語で止まった人。AWS と OAuth の基礎は知っている前提で書く。

## 要旨
- サービスの身元は SPIFFE ID で表し、SPIRE が X.509-SVID（証明書）として配る。
- 利用者の権限は、token exchange で発行し直したトークンで奥のサービスまで運ぶ。
- 受け取る側は、証明書の SPIFFE ID とトークンの `act.client_id` が対応するかを確かめる。

## 用語
| 用語 | 意味 |
|---|---|
| SPIFFE | サービスの身元を表す標準。身元を URI（SPIFFE ID）で書く |
| SPIFFE ID | `spiffe://<信頼ドメイン>/<パス>` の形の身元。この検証では `spiffe://gekko13.internal/svc/<サービス名>` |
| 信頼ドメイン | 同じ認証局を信頼する範囲。この検証では `gekko13.internal` |
| SVID | SPIFFE ID を載せた身元の証明。この検証では X.509 の証明書（X.509-SVID）だけを使う。SAN の URI に SPIFFE ID が入る |
| SPIRE | SPIFFE の実装。server が証明書に署名し、各ホストの agent がワークロードに配る |
| attestor | SPIRE が身元を確かめる部品。ノード（ホスト）用とワークロード（プロセス）用がある |
| join_token | 一度だけ使えるトークンで、ノードを登録する attestor。ローカルで使う |
| aws_iid | EC2 のインスタンス識別ドキュメントで、ノードを確かめる attestor。AWS で使う |
| docker の attestor | 呼び出し元のプロセスから docker のコンテナを探し、コンテナのラベルなどで見分ける attestor |
| spiffe-helper | SPIRE の agent から SVID を受け取り、ファイルに書くサイドカー。入れ替えのたびに書き直す |
| 登録（エントリー） | SPIRE の server に置く、「この条件のワークロードに、この SPIFFE ID を配る」という対応 |
| セレクター | 登録の条件。例えば `docker:label:com.amazonaws.ecs.task-definition-family:gekko13-ledger` |
| token exchange | RFC 8693 の、受け取ったトークンを別のトークンに交換する手続き。この検証では委任（actor を付ける）で使う |
| `act.client_id` | 交換したトークンで、交換させた呼び出し元（actor）の client を示すクレーム |
| BFF | Backend for Frontend。利用者の画面の受け口で、最初の交換をする |
| transfer、ledger | 振込を受け付けるサービスと、記帳する最も奥のサービス |
| bridge モード | ECS のネットワークモードの 1 つ。コンテナは docker のブリッジにつながり、同じタスクでもネットワークを共有しない |
| awsvpc モード | ECS のネットワークモードの 1 つ。タスクごとに ENI（ネットワークの口）を持つ。この検証では、SPIRE server だけが使う |
| DAEMON | ECS のサービスの置き方の 1 つ。どの台にも 1 つずつタスクを置く。この検証では、SPIRE の agent に使う |
| キャパシティプロバイダー | ECS が、タスクを置く台（ここでは Auto Scaling グループ）を扱うための設定。台の数を ECS に任せられる |
| マネージドスケーリング | キャパシティプロバイダーの機能。置くタスクに合わせて、台の数を増減する。指標は `CapacityProviderReservation`（必要と見積もった台数 ÷ 今の台数）で、DAEMON のタスクは数えない |
| Service Connect | ECS の、サービスどうしを名前で呼ばせる仕組み。各タスクに Envoy を足して中継する。この検証では TCP の中継だけに使う |
| Cloud Map | AWS の、サービスの名前と居場所を登録する仕組み。この検証では、Service Connect の名前空間と、SPIRE server の DNS の名前（`spire-server.svc.gekko13.internal`）に使う |
| デュアルスタックの名前 | IPv4 と IPv6 の両方で届く、AWS の API の名前（`*.api.aws`、`*.on.aws`）。既定の名前（`*.amazonaws.com`）は IPv4 だけのものがある |
| registrar | SPIRE server のタスクの中のコンテナ（`scripts/spire-registrar.sh`）。登録を作り、agent が最初に信じるバンドルを EFS に書く |
| プローブ（乗っ取られたタスク） | AWS でシナリオを回す役。bff、transfer、ledger の本物のファミリーの別の版のタスクとして動き、自分が得た SVID だけで攻撃する。サービス名は probe-bff、probe-transfer、probe-ledger |
| rogue | シナリオ 1-b の、登録していないファミリー（`gekko13-rogue`）のタスク |
| 段 A、段 B | 第 1 部の AWS の段の分け方。段 A は 1 つの AZ で各サービス 1 タスク、段 B は 2 つの AZ で各サービス 2 タスク |
| 段 C、段 D、段 E | 第 2 部の段の分け方。段 C は方式が基盤で成り立つかの確認、段 D は gekko_11 の流れと 27 のシナリオ、段 E は 2 つの AZ と、防御を外した複製（[plan.md](plan.md)） |
| 営業 AI エージェント | 顧客の代理として、保険の案を組み立て、申込みを取り次ぐ AI。どの署名の鍵も持たない（gekko_11） |
| 事務サービス | 営業 AI エージェントからの依頼を、保険会社のシステムへ取り次ぐサービス（gekko_11） |
| トークン A、B、C | 段ごとに宛先を分けたアクセストークン。A は顧客のアプリから営業 AI エージェントへ、B は事務サービスへ、C は保険会社のシステムへ。替えるたびに、経由した者を `act` に積む（gekko_11） |
| `may_act` | トークンの中で、そのトークンを代理として使ってよい者を示すクレーム。交換のときに、頼んだ者がこれに含まれるかを確かめる |
| `cnf` | トークンを、持ち主の鍵に結び付けるクレーム。鍵（DPoP の鍵や、mTLS の証明書）を持たない者は、盗んだトークンを使えない |
| DPoP | RFC 9449。トークンを、送り手の鍵に結び付ける方式。要求ごとに、その鍵で署名した証明（proof）を添える |
| RFC 8705 | トークンを、mTLS の証明書に結び付ける方式（証明書に結び付いたトークン）。この検証では、SVID の証明書に結ぶ |
| RAR | RFC 9396。トークンに、扱ってよい範囲（契約の種類や上限）を、構造化した値で載せる方式 |
| JCS | RFC 8785。JSON を、決まった並びと書き方に正規化する方式。署名する内容のハッシュを、誰が計算しても同じにする |
| RP ID | パスキー（WebAuthn）で、鍵を結び付けるサイトの名前。この検証では、CloudFront の既定のドメイン |
| VPC origin | CloudFront の送り先の種類の 1 つ。プライベートのサブネットの EC2 のインスタンスなどを、ARN で指す。CloudFront が VPC の中に ENI とグループ（`CloudFront-VPCOrigins-Service-SG`）を作って届く |
| VPC origin の組（A と B） | この検証で、VPC origin を 2 組持つ作り。CloudFront は配信が使っている VPC origin を書き換えさせないので、使っていない組を新しい台に向けてから、配信を切り替える |
| EIGW | Egress-only のインターネットゲートウェイ。IPv6 で外へ出る通信だけを通し、外から始まる接続は通さない |
| ALB | Application Load Balancer。HTTP の要求ごとに、送り先（ターゲット）へ振り分ける。この検証の段 D の D0 では、内部向けの ALB を CloudFront の VPC origin から指した。D0-b で、入口の中継に替えた |
| ターゲットグループ | ALB の送り先の組。ECS は、動き出したタスクを、台と、台のポートの組で登録する |
| Web Functions | Lambda の形の 1 つ。ポートで待ち受ける Node.js の HTTP サーバーを、そのまま動かす。使わない間は 0 まで縮み、固定費がない。この検証では、入口の中継に使う |
| 入口の中継 | この検証の段 D の D0-b から、CloudFront と台の間に置く Web Functions。パスで送り先を決め、VPC の中のタスクへ要求をそのまま送る |
| NetworkConnector | Lambda の Web Functions と MicroVMs が、VPC のサブネットとグループを通って外へ出るための設定。ENI は Lambda が作る |
| OAC | Origin Access Control。CloudFront が、送り先への要求に SigV4 で署名する仕組み。送り先は、署名で CloudFront からの要求だけを受ける |
| SRV | DNS のレコードの種類の 1 つ。名前に、送り先の名前とポートの組を対応させる。ECS は bridge のタスクを、台の IP と動的なポートの組で、Cloud Map の SRV に登録する |
| Aurora Serverless v2 | Aurora の、負荷に合わせて計算の量（ACU）を増減させる形。最小を 0 ACU にすると、つながりがない間は止まり、計算の費用がかからない。この検証の段 D の D1-a1 から、全部のサービスの保存先にする |
| ACU | Aurora Capacity Unit。Aurora Serverless v2 の計算の量の単位。費用は ACU 時間で決まる |
| Aurora DSQL | AWS の、サーバーを持たない分散のデータベース。PostgreSQL と互換の部分がある。使わない間は費用がかからない。この検証では比べて退けた |
| DPU | Distributed Processing Unit。Aurora DSQL の、処理の量の単位。費用は DPU の数で決まる |
| IAM のデータベース認証 | パスワードの代わりに、IAM の認証情報で署名した短い期限のトークンで、データベースにつなぐ方式 |
| JGroups | Keycloak が、複数のタスクどうしでキャッシュを共有するための通信の部品。相手の見つけ方の 1 つに、データベースを使う `jdbc-ping` がある |
| Application Auto Scaling | ECS のサービスのタスクの数などを、CloudWatch のアラームに合わせて増減させる仕組み |
| 根の CA と中間の CA | SPIRE の CA の 2 段の作り。根の CA を 1 つ置き、各 SPIRE server はその下で中間の CA を作って SVID に署名する。バンドルは根の証明書だけになる。この検証の段 D の D1-a1 から使う |
| UpstreamAuthority | SPIRE server が、自分の CA を、上流の CA の下に作らせる設定。`disk` は、根の CA の証明書と鍵をファイルから読む |
| token-guard | gekko_11 の部品。受け口でトークンと呼び手を確かめ、出口でトークンを替える。gekko_11 ではサイドカーで、段 D では各アプリが読むライブラリにする |
| 直送 | 保険会社のシステムが、契約の内容を、AI を通さずに、本人が登録した宛先へ直接送ること。本人は、手元の写しと見比べる（gekko_11） |
