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
