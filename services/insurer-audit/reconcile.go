package main

// 契約ごとに、保険会社のシステムの記録（自己申告）を、第三者の記録（認可サーバーの交換の記録、事務サービスのツールの記録）と
// 突き合わせ、食い違いを示す（gekko_11 の D-17、G25）。gekko_11 の Reconciler.java を、判定と文言を変えずに写した。
//   - 書いた者は、記録の中の欄ではなく、記録の集約が付ける印で決める。合わない記録は受け付けず、食い違いとして示す（gekko_11 の D-32）
//   - 申込みの中身の根拠は、事務サービスが算出したハッシュである。会話の記録は営業 AI エージェントの自己申告なので、
//     食い違いに気付くためだけに比べる

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/gowebpki/jcs"
)

// Route は、決まった取り次ぎの道（C の act の並び）。保険会社のシステムに近い順。
var Route = []string{"insurer-mcp", "sales-agent"}

var names = map[string]string{"insurer-mcp": "事務サービス", "sales-agent": "営業 AI エージェント"}

const (
	backend         = "保険会社のシステム"
	authServer      = "認可サーバー"
	mcp             = "事務サービス"
	agent           = "営業 AI エージェント"
	self            = "保険会社のシステムの自己申告"
	logged          = "保険会社のシステムの CloudWatch Logs の記録"
	selfApplication = "自己申告の申込みから監査サービスが算出"

	match      = "一致"
	mismatch   = "食い違い"
	notCompare = "比べていない"

	thirdParty = "third_party"
	sameWriter = "same_writer"
	selfReport = "self_report"
	provenance = "provenance"
)

// Comparison は、比べた 2 つの値と、それぞれを書いた者。値は画面に出す形で、識別子とハッシュは先頭だけにする。一致は元の値で決める。
type Comparison struct {
	What    string `json:"what"`
	Left    string `json:"left"`
	LeftBy  string `json:"leftBy"`
	Right   string `json:"right"`
	RightBy string `json:"rightBy"`
	OK      bool   `json:"ok"`
}

// Check は、確かめた点。Basis は根拠の強さで、groups のどれかである。
type Check struct {
	Name        string       `json:"name"`
	Basis       string       `json:"basis"`
	OK          bool         `json:"ok"`
	Detail      string       `json:"detail"`
	Comparisons []Comparison `json:"comparisons"`
}

// Verdict は、画面に出す判定。比べる値がなかった点を、一致と見せない。記録の書き手は、値を比べずに記録ごとに確かめる。
func (c Check) Verdict() string {
	if !c.OK {
		return mismatch
	}
	if len(c.Comparisons) == 0 && c.Basis != provenance {
		return notCompare
	}
	return match
}

// Group は、根拠の強さごとのまとまり。Compared は何と何を比べたかで、Summary は比べた結果の要約である。
type Group struct {
	Title    string  `json:"title"`
	Compared string  `json:"compared"`
	Note     string  `json:"note"`
	OK       bool    `json:"ok"`
	Verdict  string  `json:"verdict"`
	Summary  string  `json:"summary"`
	Checks   []Check `json:"checks"`
}

// groups は、画面に出す順。「食い違いなし」が何に支えられているかを、根拠の強さで読めるようにする。
var groups = [][4]string{
	{thirdParty, "第三者の記録との比較", "保険会社のシステムの契約の記録 ↔ 認可サーバーの交換の記録、事務サービスのツールの記録",
		"保険会社のシステムと別の者が書いた記録と比べる。判定の中心である。"},
	{sameWriter, "同じ書き手の記録どうしの比較", "保険会社のシステムの自己申告 ↔ CloudWatch Logs の契約の記録",
		"どちらも保険会社のシステムが書いた。後からの書き換えには気付けるが、独立した裏付けではない。"},
	{selfReport, "自己申告との比較", "営業 AI エージェントが会話で示した申込み ↔ 事務サービスが取り次いだ申込み",
		"営業 AI エージェントは書き換えうる者で、根拠にしない。食い違いに気付くためだけに比べる。"},
	{provenance, "記録の書き手", "関わる記録を書いたタスク ↔ 記録の種類ごとに決まった書き手",
		"記録の中の欄ではなく、ログストリームの名前（タスクの定義が決める）で確かめる。"},
}

// Report は、契約ごとの突き合わせの結果。Chain は、保険会社のシステムが受け取ったトークン（C）から遡った順である。
type Report struct {
	Nonce          string           `json:"nonce"`
	Contract       map[string]any   `json:"contract"`
	OK             bool             `json:"ok"`
	Status         string           `json:"status"`
	Checks         []Check          `json:"checks"`
	ContractRecord map[string]any   `json:"contractRecord"`
	SelfReport     map[string]any   `json:"selfReport"`
	Chain          []map[string]any `json:"chain"`
	Tool           map[string]any   `json:"tool"`
	Thread         string           `json:"thread"`
	Conversation   []map[string]any `json:"conversation"`
	Rejected       []map[string]any `json:"rejected"`
}

// Groups は、確かめた点を、根拠の強さごとにまとめる。
func (r Report) Groups() []Group {
	out := []Group{}
	for _, g := range groups {
		var members []Check
		var compared []Comparison
		for _, c := range r.Checks {
			if c.Basis == g[0] {
				members = append(members, c)
				compared = append(compared, c.Comparisons...)
			}
		}
		summary := ""
		if len(compared) == 0 {
			if len(members) > 0 {
				summary = members[0].Detail
			}
		} else {
			n := 0
			for _, c := range compared {
				if c.OK {
					n++
				}
			}
			summary = fmt.Sprintf("%d 点中 %d 点が一致", len(compared), n)
		}
		ok, hasMismatch, hasMatch := true, false, false
		for _, c := range members {
			ok = ok && c.OK
			switch c.Verdict() {
			case mismatch:
				hasMismatch = true
			case match:
				hasMatch = true
			}
		}
		verdict := notCompare
		if hasMismatch {
			verdict = mismatch
		} else if hasMatch {
			verdict = match
		}
		out = append(out, Group{Title: g[1], Compared: g[2], Note: g[3], OK: ok, Verdict: verdict, Summary: summary, Checks: members})
	}
	return out
}

// Summary は、一覧の 1 行。
type Summary struct {
	Nonce    string         `json:"nonce"`
	Contract map[string]any `json:"contract"`
	OK       bool           `json:"ok"`
	Status   string         `json:"status"`
}

// Reconciler は、記録の出どころから読んで突き合わせる。
type Reconciler struct{ Source Source }

// List は、新しい順に、契約の突き合わせの結果を返す。
func (rc Reconciler) List(limit int) ([]Summary, error) {
	selfs, err := rc.Source.SelfReported()
	if err != nil {
		return nil, err
	}
	loggedEntries, err := rc.Source.Contracts()
	if err != nil {
		return nil, err
	}
	sort.SliceStable(loggedEntries, func(i, j int) bool { return loggedEntries[i].At > loggedEntries[j].At })
	var nonces []string
	seen := map[string]bool{}
	add := func(n string) {
		if n != "" && !seen[n] {
			seen[n] = true
			nonces = append(nonces, n)
		}
	}
	for _, e := range loggedEntries {
		if e.WrittenByOwner() {
			add(str(mapOf(e.Get("contract"))["nonce"]))
		}
	}
	for i := len(selfs) - 1; i >= 0; i-- {
		add(str(mapOf(selfs[i]["contract"])["nonce"]))
	}
	out := []Summary{}
	for _, n := range nonces {
		if len(out) >= limit {
			break
		}
		r, err := rc.reconcile(n, selfs)
		if err != nil {
			return nil, err
		}
		if r != nil {
			out = append(out, Summary{Nonce: n, Contract: r.Contract, OK: r.OK, Status: r.Status})
		}
	}
	return out, nil
}

// Reconcile は、その nonce の契約を突き合わせる。契約がなければ nil。
func (rc Reconciler) Reconcile(nonce string) (*Report, error) {
	selfs, err := rc.Source.SelfReported()
	if err != nil {
		return nil, err
	}
	return rc.reconcile(nonce, selfs)
}

func (rc Reconciler) reconcile(nonce string, allSelf []map[string]any) (*Report, error) {
	sn := &seenSet{source: rc.Source, cache: map[string][]Entry{}, rejected: map[string]map[string]any{}}
	byNonce, err := sn.search(nonce)
	if err != nil {
		return nil, err
	}
	var contracts []map[string]any
	for _, e := range byNonce {
		if e.WrittenByOwner() && e.Kind() == "contract" && str(mapOf(e.Get("contract"))["nonce"]) == nonce {
			contracts = append(contracts, e.Record)
		}
	}
	var selfs []map[string]any
	for _, s := range allSelf {
		if str(mapOf(s["contract"])["nonce"]) == nonce {
			selfs = append(selfs, s)
		}
	}
	if len(contracts) == 0 && len(selfs) == 0 {
		return nil, nil
	}
	var contractRecord, selfRecord map[string]any
	if len(contracts) > 0 {
		contractRecord = contracts[0]
	}
	if len(selfs) > 0 {
		selfRecord = selfs[0]
	}
	var contract map[string]any
	if contractRecord != nil {
		contract = mapOf(contractRecord["contract"])
	} else {
		contract = mapOf(selfRecord["contract"])
	}
	customer := contract["customer"]
	var checks []Check

	// 保険会社のシステムの自己申告と、CloudWatch Logs に残った契約の記録
	c := []Comparison{{What: "この nonce の契約の件数", Left: fmt.Sprintf("%d 件", len(selfs)), LeftBy: self,
		Right: fmt.Sprintf("%d 件", len(contracts)), RightBy: logged, OK: len(selfs) == 1 && len(contracts) == 1}}
	var p []string
	if len(contracts) != len(selfs) {
		p = append(p, fmt.Sprintf("CloudWatch Logs の契約の記録が %d 件で、自己申告が %d 件である", len(contracts), len(selfs)))
	}
	if len(contracts) > 1 || len(selfs) > 1 {
		p = append(p, "同じ nonce の契約が、複数ある")
	}
	if contractRecord != nil && selfRecord != nil {
		c = append(c, same("契約の中身（ハッシュ）", shortID(hash(selfRecord["contract"])), hash(selfRecord["contract"]), self,
			shortID(hash(contractRecord["contract"])), hash(contractRecord["contract"]), logged))
		c = append(c, same("経由", routeText(selfRecord["by"]), selfRecord["by"], self, routeText(contractRecord["by"]), contractRecord["by"], logged))
		c = append(c, sameID("受け取ったトークンの jti", selfRecord["tokenJti"], self, contractRecord["token_jti"], logged))
		c = append(c, sameID("申込みのハッシュ", hash(selfRecord["application"]), selfApplication, contractRecord["application_hash"], logged))
		if canonical(contractRecord["contract"]) != canonical(selfRecord["contract"]) {
			p = append(p, "契約の中身が違う")
		}
		if !equal(contractRecord["by"], selfRecord["by"]) {
			p = append(p, "経由が違う")
		}
		if !equal(contractRecord["token_jti"], selfRecord["tokenJti"]) {
			p = append(p, "受け取ったトークンの jti が違う")
		}
		if !equal(contractRecord["application_hash"], hash(selfRecord["application"])) {
			p = append(p, "申込みのハッシュが違う")
		}
	}
	checks = append(checks, check("自己申告と、契約の記録", sameWriter, p, "自己申告と、CloudWatch Logs の契約の記録が一致する", c))

	// トークンの連鎖: C → B → A を、認可サーバーの記録で遡る
	var tokenJti string
	if contractRecord != nil {
		tokenJti = str(contractRecord["token_jti"])
	} else {
		tokenJti = str(selfRecord["tokenJti"])
	}
	var chain []Entry
	missing := ""
	for jti := tokenJti; jti != "" && len(chain) < 5; {
		issued, err := issuedWith(sn, jti)
		if err != nil {
			return nil, err
		}
		if issued == nil {
			missing = jti
			break
		}
		chain = append(chain, *issued)
		if issued.Kind() == "issue" {
			break
		}
		jti = str(issued.Get("from_jti"))
	}
	route := []string{}
	for _, e := range chain {
		if e.Kind() == "exchange" {
			route = append(route, str(e.Get("client")))
		}
	}
	traced := len(chain) > 0 && missing == "" && chain[len(chain)-1].Kind() == "issue" && str(chain[len(chain)-1].Get("client")) == "customer-app"
	c = []Comparison{{What: "受け取ったトークンから、ログインまで遡る", Left: shortID(nilIfEmpty(tokenJti)), LeftBy: backend,
		Right: chainText(chain, missing), RightBy: authServer, OK: traced}}
	c = append(c, same("取り次ぎの道", routeText(route), route, authServer, routeText(Route), Route, "決まった道"))
	var subs []string
	subSeen := map[string]bool{}
	for _, e := range chain {
		s := str(e.Get("sub"))
		if !subSeen[s] {
			subSeen[s] = true
			subs = append(subs, s)
		}
	}
	subsText := text(nil)
	if len(subs) > 0 {
		subsText = strings.Join(subs, "、")
	}
	c = append(c, Comparison{What: "本人（sub）", Left: text(customer), LeftBy: backend, Right: subsText, RightBy: authServer,
		OK: len(subs) == 1 && subs[0] == fmt.Sprint(customer)})
	p = nil
	if tokenJti == "" {
		p = append(p, "契約の記録に、受け取ったトークンの jti がない")
	} else if len(chain) == 0 {
		p = append(p, "保険会社のシステムが受け取ったトークン（jti "+tokenJti+"）を出した記録が、認可サーバーにない")
	} else {
		first := chain[len(chain)-1]
		if missing != "" {
			p = append(p, "連鎖が途中で切れている（jti "+missing+" を出した記録がない）")
		} else if first.Kind() != "issue" || str(first.Get("client")) != "customer-app" {
			p = append(p, "最初のトークンが、顧客のアプリへのログインで出ていない")
		}
		if chain[0].Kind() == "issue" {
			p = append(p, "保険会社のシステムが受け取ったのは、ログインで出した A そのものである")
		} else if !equal(route, Route) {
			p = append(p, fmt.Sprintf("取り次ぎの道 %v が、決まった道 %v と違う", route, Route))
		}
		for _, e := range chain {
			if !equal(customer, e.Get("sub")) {
				p = append(p, fmt.Sprintf("本人（sub）が、契約の顧客 %v と違う", customer))
				break
			}
		}
	}
	checks = append(checks, check("トークンの連鎖", thirdParty, p, "ログインの A から、交換の B と C まで、認可サーバーの記録でたどれる", c))

	// 経由: 契約の記録の by と C の act を、交換の記録の道と比べる
	var by any
	if contractRecord != nil {
		by = contractRecord["by"]
	} else {
		by = selfRecord["by"]
	}
	c, p = nil, nil
	if len(chain) > 0 {
		c = append(c, same("契約の記録の経由", routeText(by), by, backend, routeText(route), route, authServer))
		tokenAct := actChain(chain[0].Get("act"))
		c = append(c, same("C の act", routeText(tokenAct), tokenAct, authServer, routeText(route), route, authServer))
		if !equal(by, route) {
			p = append(p, fmt.Sprintf("契約の記録の経由 %v が、交換の記録の道 %v と違う", by, route))
		}
		if !equal(tokenAct, route) {
			p = append(p, fmt.Sprintf("C の act %v が、交換の記録の道 %v と違う", tokenAct, route))
		}
	} else {
		p = append(p, "比べる交換の記録がない")
	}
	checks = append(checks, check("経由", thirdParty, p, "契約の記録の経由と C の act が、交換の記録の道と一致する", c))

	// 事務サービスのツールの記録
	var chainB any
	if len(chain) == 3 {
		chainB = chain[1].Get("jti")
	}
	tool := submitted(byNonce, nonce, str(contract["contractId"]), chainB)
	c, p = nil, nil
	if tool == nil {
		p = append(p, "事務サービスに、この申込みを取り次いだ記録がない")
		c = append(c, Comparison{What: "この申込みを取り次いだ記録", Left: text(contract["contractId"]), LeftBy: backend, Right: text(nil), RightBy: mcp, OK: false})
	} else {
		c = append(c, same("依頼の本人（sub）", text(customer), customer, backend, text(tool.Get("sub")), tool.Get("sub"), mcp))
		if len(chain) == 3 {
			c = append(c, sameID("事務サービスが受け取ったトークン（B）", tool.Get("jti"), mcp, chain[1].Get("jti"), authServer))
		}
		if !equal(customer, tool.Get("sub")) {
			p = append(p, fmt.Sprintf("事務サービスへの依頼の本人（sub）%v が、契約の顧客と違う", tool.Get("sub")))
		}
		if len(chain) == 3 && !equal(tool.Get("jti"), chain[1].Get("jti")) {
			p = append(p, "事務サービスが受け取ったトークンが、連鎖の B と違う")
		}
	}
	checks = append(checks, check("事務サービスの記録", thirdParty, p, "事務サービスが、本人の依頼として、この申込みを取り次いだ", c))

	// 申込みの中身: 根拠は、事務サービスが算出したハッシュ
	var applicationHash any
	if tool != nil {
		applicationHash = tool.Get("application_hash")
	}
	c, p = nil, nil
	if tool == nil {
		p = append(p, "比べる事務サービスの記録がない")
	} else {
		if contractRecord != nil {
			c = append(c, sameID("申込みのハッシュ", contractRecord["application_hash"], backend, applicationHash, mcp))
		}
		if selfRecord != nil {
			c = append(c, sameID("自己申告の申込みのハッシュ", hash(selfRecord["application"]), selfApplication, applicationHash, mcp))
		}
		contractPlan := mapOf(contract["plan"])["id"]
		toolPlan := mapOf(tool.Get("plan"))["id"]
		c = append(c, same("案", text(contractPlan), contractPlan, backend, text(toolPlan), toolPlan, mcp))
		c = append(c, same("顧客", text(customer), customer, backend, text(tool.Get("customer")), tool.Get("customer"), mcp))
		if contractRecord != nil && !equal(applicationHash, contractRecord["application_hash"]) {
			p = append(p, "契約の記録の申込みのハッシュが、事務サービスが取り次いだ申込みと違う")
		}
		if selfRecord != nil && !equal(applicationHash, hash(selfRecord["application"])) {
			p = append(p, "自己申告の申込みが、事務サービスが取り次いだ申込みと違う")
		}
		if !equal(toolPlan, contractPlan) {
			p = append(p, fmt.Sprintf("契約の案 %v が、取り次いだ申込みの案 %v と違う", contractPlan, toolPlan))
		}
		if !equal(tool.Get("customer"), customer) {
			p = append(p, "契約の顧客が、取り次いだ申込みの顧客と違う")
		}
	}
	checks = append(checks, check("申込みの中身", thirdParty, p, "契約の案と申込みが、事務サービスが取り次いだ申込みと一致する", c))

	// 会話: 営業 AI エージェントの自己申告。示した申込みのハッシュを、事務サービスのハッシュと比べ、食い違いに気付く
	thread := ""
	for _, e := range byNonce {
		if e.WrittenByOwner() && e.Kind() == "conversation" {
			thread = str(e.Get("thread"))
		}
	}
	conversation := []map[string]any{}
	if thread != "" {
		found, err := sn.search(thread)
		if err != nil {
			return nil, err
		}
		for _, e := range found {
			if e.WrittenByOwner() && e.Kind() == "conversation" && str(e.Get("thread")) == thread {
				conversation = append(conversation, e.Record)
			}
		}
	}
	shown := ""
	for _, r := range conversation {
		if str(r["name"]) == "present_application" && r["document_hash"] != nil {
			shown = str(r["document_hash"])
		}
	}
	var note string
	c, p = nil, nil
	if shown != "" && applicationHash != nil {
		c = append(c, sameID("示した申込みのハッシュ", shown, agent, applicationHash, mcp))
	}
	switch {
	case thread == "":
		note = "会話の記録がない（営業 AI エージェントとの会話を通らない申込み）"
	case shown == "" || applicationHash == nil:
		note = "比べる申込みの提示か、事務サービスの記録がない"
	case shown == str(applicationHash):
		note = "会話で示した申込みと、取り次いだ申込みのハッシュが同じ"
	default:
		p = append(p, "会話で示した申込みと、事務サービスが取り次いだ申込みのハッシュが違う")
	}
	checks = append(checks, check("会話（営業 AI エージェントの自己申告。確かめていない）", selfReport, p, note, c))

	// 書いた者が合わない記録（記録の偽装）。受け付けず、食い違いとして示す
	rejected := sn.rejectedList()
	p = nil
	for _, r := range rejected {
		p = append(p, fmt.Sprintf("%v の記録を %v（%v）が書いた。書いてよいのは %v だけ", r["kind"], r["app"], r["container"], r["expected"]))
	}
	checks = append(checks, check("書いた者", provenance, p, "関わる記録は、全て書いてよい者が書いた", nil))

	ok := true
	for _, ch := range checks {
		ok = ok && ch.OK
	}
	status := "食い違いあり"
	if ok {
		status = "食い違いなし"
	}
	chainRecords := []map[string]any{}
	for _, e := range chain {
		chainRecords = append(chainRecords, e.Record)
	}
	var toolRecord map[string]any
	if tool != nil {
		toolRecord = tool.Record
	}
	return &Report{Nonce: nonce, Contract: contract, OK: ok, Status: status, Checks: checks, ContractRecord: contractRecord,
		SelfReport: selfRecord, Chain: chainRecords, Tool: toolRecord, Thread: thread, Conversation: conversation, Rejected: rejected}, nil
}

// issuedWith は、その jti のトークンを出した、認可サーバーかログインサーバーの記録。
func issuedWith(sn *seenSet, jti string) (*Entry, error) {
	found, err := sn.search(jti)
	if err != nil {
		return nil, err
	}
	for _, e := range found {
		if e.WrittenByOwner() && (e.Kind() == "exchange" || e.Kind() == "issue") && str(e.Get("jti")) == jti {
			return &e, nil
		}
	}
	return nil, nil
}

// submitted は、事務サービスの submit_application の記録。契約を作ったトークンの連鎖の B（chainB）と同じトークンのものを選ぶ。
// 窓口が提出を送り直すと（段 D の D1-a3。返事が届かなかった提出を、同じ申込みで送り直す）、記録が複数になり、契約の番号は、
// 受け付け済みと返された 2 度目の記録にも付くためである。なければ、契約の番号が合うもの、それもなければ通ったものの最後を選ぶ。
func submitted(byNonce []Entry, nonce, contractID string, chainB any) *Entry {
	var tools []Entry
	for _, e := range byNonce {
		if e.WrittenByOwner() && e.Kind() == "tool_call" && str(e.Get("tool")) == "submit_application" && str(e.Get("nonce")) == nonce {
			tools = append(tools, e)
		}
	}
	for _, e := range tools {
		if chainB != nil && equal(chainB, e.Get("jti")) {
			return &e
		}
	}
	for _, e := range tools {
		if contractID != "" && str(e.Get("contract_id")) == contractID {
			return &e
		}
	}
	var last *Entry
	for i := range tools {
		if equal(200, tools[i].Get("status")) {
			last = &tools[i]
		}
	}
	return last
}

// actChain は、act の入れ子を、外側（保険会社のシステムに近い者）から並べる。
func actChain(act any) []string {
	chain := []string{}
	for a := mapOf(act); len(a) > 0; a = mapOf(a["act"]) {
		chain = append(chain, str(a["sub"]))
	}
	return chain
}

func check(name, basis string, problems []string, okDetail string, comparisons []Comparison) Check {
	if comparisons == nil {
		comparisons = []Comparison{}
	}
	if len(problems) == 0 {
		return Check{Name: name, Basis: basis, OK: true, Detail: okDetail, Comparisons: comparisons}
	}
	return Check{Name: name, Basis: basis, OK: false, Detail: strings.Join(problems, "。"), Comparisons: comparisons}
}

func same(what, left string, leftValue any, leftBy, right string, rightValue any, rightBy string) Comparison {
	return Comparison{What: what, Left: left, LeftBy: leftBy, Right: right, RightBy: rightBy, OK: leftValue != nil && equal(leftValue, rightValue)}
}

// sameID は、識別子やハッシュを比べる。画面には先頭だけを出す。
func sameID(what string, left any, leftBy string, right any, rightBy string) Comparison {
	return same(what, shortID(left), nilIfEmpty(left), leftBy, shortID(right), nilIfEmpty(right), rightBy)
}

// equal は、2 つの値が同じか。JSON で読んだ値とコードの値（リストと数の型）の違いを、正規化した文字列で吸収する。
// どちらかが nil なら、両方が nil のときだけ同じ（gekko_11 の Objects.equals と同じ）。
func equal(a, b any) bool {
	a, b = nilIfEmpty(a), nilIfEmpty(b)
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return canonical(a) == canonical(b)
}

func text(v any) string {
	if v = nilIfEmpty(v); v == nil {
		return "（なし）"
	}
	return fmt.Sprint(v)
}

func shortID(v any) string {
	s := text(v)
	if nilIfEmpty(v) == nil || len([]rune(s)) <= 10 {
		return s
	}
	return string([]rune(s)[:8]) + "…"
}

// routeText は、取り次ぎの道を、保険会社のシステムに近い順に、サービスの呼び名で書く。
func routeText(route any) string {
	list := toList(route)
	if len(list) == 0 {
		return "（なし）"
	}
	out := make([]string, len(list))
	for i, n := range list {
		s := fmt.Sprint(n)
		if name, ok := names[s]; ok {
			s = name
		}
		out[i] = s
	}
	return strings.Join(out, " ← ")
}

// chainText は、C から遡った連鎖。A、B、C はトークンの呼び名で、切れた所を示す。
func chainText(chain []Entry, missing string) string {
	var parts []string
	for _, e := range chain {
		label := text(e.Get("client"))
		switch {
		case e.Kind() == "issue":
			label = "A"
		case str(e.Get("client")) == "insurer-mcp":
			label = "C"
		case str(e.Get("client")) == "sales-agent":
			label = "B"
		}
		parts = append(parts, label+" "+shortID(e.Get("jti")))
	}
	if missing != "" {
		parts = append(parts, shortID(missing)+" の記録なし")
	}
	if len(parts) == 0 {
		return "（なし）"
	}
	return strings.Join(parts, " ← ")
}

// hash は、JCS（RFC 8785）で正規化した内容の SHA-256 の base64url。事務サービスと保険会社のシステムと同じ算出（gekko_11 の D-32）。
func hash(v any) any {
	if v == nil {
		return nil
	}
	sum := sha256.Sum256([]byte(canonical(v)))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func canonical(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("正規化できない: %v", err))
	}
	out, err := jcs.Transform(raw)
	if err != nil {
		panic(fmt.Sprintf("正規化できない: %v", err))
	}
	return string(out)
}

func mapOf(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func toList(v any) []any {
	switch l := v.(type) {
	case []any:
		return l
	case []string:
		out := make([]any, len(l))
		for i, s := range l {
			out[i] = s
		}
		return out
	}
	return nil
}

func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

// nilIfEmpty は、空の文字列を nil として扱う（Go の文字列は nil にならないため、gekko_11 の null と揃える）。
func nilIfEmpty(v any) any {
	if s, ok := v.(string); ok && s == "" {
		return nil
	}
	return v
}

// seenSet は、1 つの突き合わせの間に読んだ記録。同じ問い合わせを繰り返さず、書いた者が合わない記録を集める。
type seenSet struct {
	source   Source
	cache    map[string][]Entry
	rejected map[string]map[string]any
	order    []string
}

func (s *seenSet) search(needle string) ([]Entry, error) {
	if found, ok := s.cache[needle]; ok {
		return found, nil
	}
	found, err := s.source.Search(needle)
	if err != nil {
		return nil, err
	}
	s.cache[needle] = found
	for _, e := range found {
		if !e.WrittenByOwner() {
			key := fmt.Sprintf("%d/%s/%s", e.At, e.App, canonical(e.Record))
			if _, ok := s.rejected[key]; !ok {
				s.rejected[key] = map[string]any{"kind": e.Kind(), "app": e.App, "container": e.Container, "expected": e.ExpectedWriter(), "record": e.Record}
				s.order = append(s.order, key)
			}
		}
	}
	return found, nil
}

func (s *seenSet) rejectedList() []map[string]any {
	out := []map[string]any{}
	for _, k := range s.order {
		out = append(out, s.rejected[k])
	}
	return out
}
