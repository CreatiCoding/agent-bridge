package main

// 모델 라우팅 (REQ-F-834): the main session judges and coordinates on its own model, and lighter work goes to
// session-only subagents on the model and effort the person chose. Kept with the person's prefs, off by default;
// while it is on, every command that starts claude carries it and the agent adds --agents, the default subagent
// model and a short rule to the system prompt. The workers' wording lives in the agent (agent/guard.mjs).

type routingWorker struct{ name, model, effort string }

// ROUTING_WORKERS: the workers in the order the settings page shows them, with their default model and effort.
var ROUTING_WORKERS = []routingWorker{
	{"checker", "haiku", "low"},
	{"Explore", "haiku", "medium"},
	{"researcher", "sonnet", "medium"},
	{"ops-runner", "sonnet", "low"},
	{"doc-writer", "sonnet", "medium"},
	{"reviewer", "opus", "medium"},
}

// ROUTING_SUBAGENT_MODEL: the model of a subagent that names none (CLAUDE_CODE_SUBAGENT_MODEL), unless set.
const ROUTING_SUBAGENT_MODEL = "sonnet"

// cleanRouting: what is kept and sent. A worker or model that is not as expected falls back to its default, a
// worker name that is not one of ROUTING_WORKERS is dropped; nothing is refused.
func cleanRouting(v any) M {
	workers := M{}
	for _, w := range ROUTING_WORKERS {
		got := mget(mget(v, "workers"), w.name)
		model := jsTrim(strField(got, "model"))
		if !launchModelRe.MatchString(model) {
			model = w.model
		}
		effort := jsTrim(strField(got, "effort"))
		if !contains(LAUNCH_EFFORTS, effort) {
			effort = w.effort
		}
		workers[w.name] = M{"model": model, "effort": effort}
	}
	sub := jsTrim(strField(v, "subagentModel"))
	if !launchModelRe.MatchString(sub) {
		sub = ROUTING_SUBAGENT_MODEL
	}
	return M{"on": mget(v, "on") == true, "subagentModel": sub, "workers": workers}
}

func routingOf(uid string) M { return cleanRouting(prefsOf(uid)["routing"]) }

// routingCmd: the routing a command that starts claude carries, or nil when it is off (the agent then adds nothing).
func routingCmd(uid string) any {
	r := routingOf(uid)
	if r["on"] != true {
		return nil
	}
	return r
}

// routingDefaults: the workers and their defaults, for the settings page's 기본값으로 되돌리기.
func routingDefaults() M {
	list := []any{}
	for _, w := range ROUTING_WORKERS {
		list = append(list, M{"name": w.name, "model": w.model, "effort": w.effort})
	}
	return M{"workers": list, "subagentModel": ROUTING_SUBAGENT_MODEL}
}

// routingView: GET /api/prefs/routing.
func routingView(uid string) M {
	out := routingOf(uid)
	out["defaults"] = routingDefaults()
	return out
}
