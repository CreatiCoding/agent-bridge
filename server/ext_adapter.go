package main

// 로컬 어댑터 (REQ-F-893): an extension's page calls an action of an adapter installed on the Mac of one of this
// person's sessions: page → POST /api/ext/<id>/adapter → this server → that Mac's agent over its own outbound link
// (ask) → the adapter → back. The server checks who asks (the session is theirs), what the extension declared in
// extension.yaml `adapters:` (each action read or write) and that the Mac's agent can; the agent checks the
// adapter's own adapter.json and never runs a write's request id twice (agent/adapters.mjs).

import (
	"regexp"
	"strings"
)

const (
	ADAPTER_IN_MAX     = 64 * 1024
	ADAPTER_ASK_MS     = 130_000 // the agent's longest adapter run (120 s) and the way there and back
	ADAPTER_WRITES_MIN = 30      // writes a minute, per person and extension
	ADAPTER_ACTIONS    = 64      // actions one extension may declare
	// inputJ (REQ-S-101): the input as the page signed it, a sealed piece while sealing (base64 and its wrapping).
	ADAPTER_INJ_MAX = ADAPTER_IN_MAX*2 + 1024
	// A sealed outcome (the agent's 512KB result, sealed) and a sealed error are passed on whole, never cut.
	ADAPTER_SEALED_MAX    = 1024 * 1024
	ADAPTER_SEALED_ERRMAX = 8 * 1024
)

var (
	adapterActionRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}(\.[a-z][a-z0-9_-]{0,31}){0,3}$`)
	adapterReqRe    = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
)

// readAdapters: extension.yaml's `adapters: {thread.read: read, thread.reply: write}`.
func (d *extDef) readAdapters(n *yNode) error {
	if n.kind != yMap {
		return &yamlErr{n.line, "adapters 아래는 \"작업 이름: read 또는 write\" 입니다"}
	}
	for _, kv := range n.pairs {
		if !adapterActionRe.MatchString(kv.key) {
			return &yamlErr{kv.line, "adapters 의 " + kv.key + " 는 쓸 수 없는 이름입니다(예: thread.read)"}
		}
		if kv.val == nil || kv.val.kind != yScalar || (kv.val.raw != "read" && kv.val.raw != "write") {
			return &yamlErr{kv.line, "adapters." + kv.key + " 는 read 또는 write 입니다"}
		}
		d.Adapters = append(d.Adapters, [2]string{kv.key, kv.val.raw})
	}
	if len(d.Adapters) > ADAPTER_ACTIONS {
		return &yamlErr{n.line, "adapters 는 " + itoa(ADAPTER_ACTIONS) + "개까지입니다"}
	}
	return nil
}

func (d *extDef) adapterAccess(action string) string {
	for _, a := range d.Adapters {
		if a[0] == action {
			return a[1]
		}
	}
	return ""
}

func (d *extDef) adapterList() []any {
	out := []any{}
	for _, a := range d.Adapters {
		out = append(out, orderedObj{{"action", a[0]}, {"access", a[1]}})
	}
	return out
}

// extAdapter: POST /api/ext/<id>/adapter (run), /adapter/status (what became of a request id), /adapter/list (the
// declared actions this Mac has). Every outcome is 200 with state; only a refused request is an error status.
func extAdapter(req *Req, res *Res, uid string, d *extDef, sub string) {
	if req.Method != "POST" {
		refuse(405, "POST 만 받아요")
	}
	if sub != "" && sub != "status" && sub != "list" {
		refuse(404, "없는 주소입니다")
	}
	if len(d.Adapters) == 0 {
		refuse(403, "이 익스텐션은 extension.yaml 에 adapters 를 적지 않았어요")
	}
	b := body(req, ADAPTER_INJ_MAX+32*1024)
	meta := ownSession(uid, mstr(b, "sid"))
	hostID := meta.host()
	out := func(m M) { jsonRes(res, 200, m) }
	if !online(hostID) {
		out(M{"ok": false, "state": "offline", "error": "세션의 맥이 연결돼 있지 않아요. 실행하지 않았어요"})
		return
	}
	if !hostHasCap(hostID, "adapters") {
		out(M{"ok": false, "state": "unsupported", "error": "그 맥의 에이전트가 아직 로컬 어댑터를 몰라요. 에이전트를 업데이트해 주세요"})
		return
	}
	// A Mac that checks signatures (trust warn·enforce), or a call the page signed, needs an agent that knows signed
	// calls (REQ-S-101): an older one would refuse it, or run it without its signature and seal. Never sent there.
	inputJ, inJ := b["inputJ"].(string)
	if (hostSigns(hostID) || inJ) && !hostHasCap(hostID, "adapterSign") {
		out(M{"ok": false, "state": "unsupported", "error": "그 맥의 에이전트가 서명된 어댑터 호출을 몰라요(신뢰 모드). 보호를 낮추지 않고 실행하지 않았어요. 에이전트를 업데이트해 주세요"})
		return
	}
	switch sub {
	case "list":
		r := ask(hostID, M{"t": "adapter", "op": "list", "ext": d.ID}, 15_000)
		if !truthy(r["ok"]) {
			out(M{"ok": false, "state": "failed", "error": orStr(r["error"], "맥에서 목록을 받지 못했어요")})
			return
		}
		// Only what this extension declared, whatever the Mac has for it.
		has := asM(r["actions"])
		actions := M{}
		for _, a := range d.Adapters {
			if has[a[0]] == a[1] {
				actions[a[0]] = a[1]
			}
		}
		problems := []any{}
		for _, p := range asArr(r["problems"]) {
			if len(problems) < 20 {
				problems = append(problems, M{"name": jsSliceTo(mstr(asM(p), "name"), 32), "error": adapterErr(mstr(asM(p), "error"), 200)})
			}
		}
		// signs: the Mac checks signatures; signed: its agent knows signed calls (REQ-S-101).
		out(M{"ok": true, "state": "done", "actions": actions, "problems": problems, "signs": hostSigns(hostID), "signed": hostHasCap(hostID, "adapterSign")})
		return
	case "status":
		rid := mstr(b, "requestId")
		if !adapterReqRe.MatchString(rid) {
			refuse(400, "requestId 는 영문·숫자·_·- 8~64자예요")
		}
		r := ask(hostID, M{"t": "adapter", "op": "status", "ext": d.ID, "requestId": rid}, 15_000)
		if !truthy(r["ok"]) {
			out(M{"ok": false, "state": "failed", "requestId": rid, "error": orStr(r["error"], "맥에서 상태를 받지 못했어요")})
			return
		}
		out(adapterOutcome(r, rid))
		return
	}
	action := mstr(b, "action")
	access := d.adapterAccess(action)
	if access == "" {
		refuse(403, "extension.yaml 의 adapters 에 "+jsSliceTo(action, 64)+" 가 없어요")
	}
	if want := mstr(b, "access"); want != "" && want != access {
		refuse(403, action+" 은 "+access+" 작업이에요")
	}
	rid := mstr(b, "requestId")
	if !adapterReqRe.MatchString(rid) {
		refuse(400, "requestId 는 영문·숫자·_·- 8~64자예요")
	}
	if inJ && len(inputJ) > ADAPTER_INJ_MAX || !inJ && len(jsonStr(b["input"])) > ADAPTER_IN_MAX {
		refuse(413, "입력이 64KB 를 넘어요")
	}
	if access == "write" && hit("ext-adapter-w|"+uid+"|"+d.ID, ADAPTER_WRITES_MIN) {
		refuse(429, "쓰기 작업이 너무 많아요. 잠시 뒤에 다시 해 주세요")
	}
	// op call: what the page's signature names (attachTrustAuth matches it). inputJ goes as it came, input otherwise.
	cmd := M{"t": "adapter", "op": "call", "ext": d.ID, "action": action, "access": access, "requestId": rid, "sid": meta.id()}
	if inJ {
		cmd["inputJ"] = inputJ
	} else {
		cmd["input"] = b["input"]
	}
	r := ask(hostID, cmd, ADAPTER_ASK_MS)
	// The Mac refused it before running (trust: no or a wrong signature): nothing ran there.
	if !truthy(r["ok"]) && mstr(r, "code") == "trust-refused" {
		out(M{"ok": false, "state": "refused", "code": "trust", "requestId": rid, "error": adapterErr(orStr(r["error"], "맥이 거절했어요"), 500)})
		return
	}
	if !truthy(r["ok"]) {
		e := orStr(r["error"], "맥에서 답을 받지 못했어요")
		if e == NOT_CONNECTED {
			out(M{"ok": false, "state": "offline", "requestId": rid, "error": "세션의 맥이 연결돼 있지 않아요. 실행하지 않았어요"})
			return
		}
		// Sent but no answer: a write may have run. It is never sent again by itself; status tells later.
		if access == "write" {
			out(M{"ok": false, "state": "unknown", "requestId": rid, "error": e + " — 실행됐는지 알 수 없어요. 같은 requestId 로 상태를 확인해 주세요"})
			return
		}
		out(M{"ok": false, "state": "failed", "requestId": rid, "error": e})
		return
	}
	out(adapterOutcome(r, rid))
}

var adapterStates = []string{"done", "failed", "refused", "unknown", "running", "none"}

// adapterOutcome: the agent's answer, its known fields only.
func adapterOutcome(r M, rid string) M {
	st := mstr(r, "state")
	if !contains(adapterStates, st) {
		st = "unknown"
	}
	o := M{"ok": st == "done", "state": st, "requestId": rid}
	if st == "done" {
		o["result"] = r["result"]
	}
	for _, k := range []string{"error", "code", "action"} {
		if v := mstr(r, k); v != "" {
			o[k] = adapterErr(strings.TrimSpace(v), 500)
		}
	}
	// A sealing Mac's outcome in one piece (REQ-S-101): passed on whole; the page reads only it.
	if v := mstr(r, "sealed"); v != "" && len(v) <= ADAPTER_SEALED_MAX && adapterSealRe.MatchString(v) {
		o["sealed"] = v
		delete(o, "result")
	}
	if at, ok := r["at"].(float64); ok {
		o["at"] = at
	}
	for _, k := range []string{"replayed", "resultDropped"} {
		if truthy(r[k]) {
			o[k] = true
		}
	}
	return o
}

// adapterErr: a text cut to n bytes, but one that holds a sealed piece is kept whole (up to ADAPTER_SEALED_ERRMAX),
// since a cut piece could no longer be opened.
func adapterErr(v string, n int) string {
	if strings.Contains(v, sealOpen) {
		return jsSliceTo(v, ADAPTER_SEALED_ERRMAX)
	}
	return jsSliceTo(v, n)
}

// adapterSealRe: exactly one sealed piece ⟦bt1:<kid>:<body>⟧.
var adapterSealRe = regexp.MustCompile(`^⟦bt1:[0-9a-f]{8}:[A-Za-z0-9_-]{38,}⟧$`)
