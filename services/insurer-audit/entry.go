// 監査サービス（段 D の D1-a2-3）。gekko_11 の insurer-audit（Java）を Go に書き直した。
package main

// Entry は、記録の集約に届いた監査の記録 1 行（gekko_11 の AuditEntry）。
// App と Container は、書いた者の印で、記録の中の欄ではなく、記録の集約が付ける。AWS では CloudWatch Logs のログストリームの名前
// （<ファミリーの接頭辞>/<コンテナ名>/<タスク>）、手元では docker のコンテナのラベル（ECS と同じ名前のファミリーとコンテナ名）から決める。
// タスクの定義とラベルは、持ち主が配置で決め、アプリは決められない（docs/design-decisions.md の監査の記録の行）。
type Entry struct {
	App       string
	Container string
	// At は、記録の集約が受け取った時刻。並べる順にだけ使う
	At     int64
	Record map[string]any
}

// writers は、記録の種類ごとに、書いてよい者（gekko_11 の D-32）。どれもコンテナ名 app のコンテナである。
var writers = map[string]string{
	"issue":        "keycloak",
	"exchange":     "auth",
	"tool_call":    "insurer-mcp",
	"contract":     "insurer-backend",
	"conversation": "sales-agent",
}

func (e Entry) Kind() string     { return str(e.Record["kind"]) }
func (e Entry) Get(k string) any { return e.Record[k] }

// WrittenByOwner は、書いた者が、その種類の記録を書いてよい者か。
func (e Entry) WrittenByOwner() bool {
	owner, ok := writers[e.Kind()]
	return ok && owner == e.App && e.Container == "app"
}

// ExpectedWriter は、その種類の記録を書いてよい者。
func (e Entry) ExpectedWriter() string {
	if w, ok := writers[e.Kind()]; ok {
		return w
	}
	return "（決まっていない種類）"
}

// Source は、突き合わせに使う記録の出どころ（gekko_11 の RecordSource）。
type Source interface {
	// Search は、その文字列（nonce、jti、会話の識別子）を含む監査の記録を、書いた者を問わずに返す。確かめは突き合わせが行う
	Search(needle string) ([]Entry, error)
	// Contracts は、契約の記録（kind が contract）。一覧の画面に使う
	Contracts() ([]Entry, error)
	// SelfReported は、保険会社のシステムの自己申告（/audit/records の契約）
	SelfReported() ([]map[string]any, error)
}
