package main

import (
	"math"
	"strings"
)

// 대화 모드 (REQ-F-907): the session's own Mac reads an answer aloud and, only when the page's rules cannot tell,
// judges whether the person has finished (turn) or says a code-heavy answer in a line (brief). The session's own Mac
// only, like 음성 입력: what is said there is that Mac's already.
const (
	TALK_TTS_MAX   = 600
	TALK_TURN_MAX  = 2000
	TALK_BRIEF_MAX = 6000
	TALK_WAIT_MS   = 60_000
)

var talkMax = map[string]int{"tts": TALK_TTS_MAX, "turn": TALK_TURN_MAX, "brief": TALK_BRIEF_MAX}

func apiTalk(res *Res, req *Req, uid string, meta *Sess) {
	needFeature("voice")
	b := body(req, 64*1024)
	prefs := cleanVoice(prefsOf(uid)["voice"])
	if !truthy(prefs["on"]) {
		refuse(409, "음성 입력이 꺼져 있어요. 설정 → 음성에서 켜 주세요")
	}
	kind := strField(b, "op")
	limit, ok := talkMax[kind]
	if !ok {
		refuse(400, "op 는 tts, turn, brief 중 하나예요")
	}
	text := strings.TrimSpace(strField(b, "text"))
	if text == "" || len([]rune(text)) > limit {
		refuse(400, "읽을 말이 비었거나 너무 길어요")
	}
	cmd := M{"t": "talk", "op": kind, "text": text}
	// 읽는 속도 (REQ-F-907): the page's choice, 0.5~2 times the voice's normal; anything else, the Mac's default.
	if rate, ok := b["rate"].(float64); ok && kind == "tts" && rate >= 0.5 && rate <= 2 {
		cmd["rate"] = math.Round(rate*100) / 100
	}
	var r M
	// 소희 (REQ-F-911): the answer read by the person's Mac that has her, the same voice for every session; when
	// that Mac cannot (off, busy, failed), the session's own machine reads it in its own voice.
	if kind == "tts" {
		if v := voiceHost(uid, meta, b["away"] != false); v != "" {
			cmd["engine"] = "qwen"
			r = ask(v, cmd, TALK_WAIT_MS)
			delete(cmd, "engine")
			if !truthy(r["ok"]) {
				r = nil
			}
		}
	}
	if r == nil {
		r = ask(liveHost(meta), cmd, TALK_WAIT_MS)
	}
	if !truthy(r["ok"]) {
		code := r["code"]
		if code == nil {
			code = "error"
		}
		refuseX(502, orStr(r["error"], "맥이 답하지 못했어요"), M{"code": code})
	}
	switch kind {
	case "tts":
		audio := strField(r, "audio")
		if audio == "" || !b64Re.MatchString(audio) {
			refuse(502, "맥이 소리를 만들지 못했어요")
		}
		jsonRes(res, 200, orderedObj{{"ok", true}, {"audio", audio}, {"mime", strField(r, "mime")}, {"engine", r["engine"]}, {"ms", r["ms"]}}.dropNil())
	case "turn":
		end := "more"
		if strField(r, "end") == "done" {
			end = "done"
		}
		jsonRes(res, 200, orderedObj{{"ok", true}, {"end", end}, {"ms", r["ms"]}}.dropNil())
	default:
		jsonRes(res, 200, orderedObj{{"ok", true}, {"line", strField(r, "line")}, {"ms", r["ms"]}}.dropNil())
	}
}
