// Plugins (server/plugins.mjs): things a person adds to their own bridge and takes out again. Each person has their
// own settings (u/<uid>/plugins.json, unchanged) and their own running copy.
package main

import (
	"regexp"
	"sort"
	"strings"
)

// PluginHost: the calls a plugin may make, as its person (bridgeHost).
type PluginHost interface {
	Origin() string
	Code() string
	Sessions() []any
	Find(thread string) M
	Command(value string) string
	Seat(thread string) M
	Summary(thread string) M
	SeatUrl(thread string, u any)
	MoveTo(thread string, to string) M
	Send(thread string, text string, images []any) M
	Start(prompt string, cwd any, places string) M
}

// PluginInst: what a plugin's start returned.
type PluginInst interface {
	status() M
	stop()
}

type onEventer interface{ onEvent(thread string, ev any) }
type seatMover interface {
	moveIn(thread string) M
	moveOut(thread string)
}
type slackLinker interface {
	link(code string) string
	who(code string) M
}

// plugHost is the host a running plugin is given: its person's calls, its own kept state, save, changed, log.
type plugHost struct {
	PluginHost
	state   M
	save    func()
	changed func()
	log     func(string)
}

type pluginField struct {
	key, label, placeholder, kind, prefix string
	secret, required                      bool
	pick                                  string
	max                                   int
}

func (f pluginField) json() orderedObj {
	o := orderedObj{{"key", f.key}, {"label", f.label}}
	if f.placeholder != "" {
		o = append(o, kv{"placeholder", f.placeholder})
	}
	if f.secret {
		o = append(o, kv{"secret", true})
	}
	if f.required {
		o = append(o, kv{"required", true})
	}
	if f.prefix != "" {
		o = append(o, kv{"prefix", f.prefix})
	}
	if f.pick != "" {
		o = append(o, kv{"pick", f.pick})
	}
	if f.kind != "" {
		o = append(o, kv{"kind", f.kind})
	}
	if f.max != 0 {
		o = append(o, kv{"max", f.max})
	}
	return o
}

type pluginDef struct {
	id, name, about string
	fields          []pluginField
	help            any
	prompt          any
	start           func(config M, host *plugHost) PluginInst
	choices         func(config M, key string) []any
}

var ALL_PLUGINS []*pluginDef

func pluginByID(id string) *pluginDef {
	for _, p := range ALL_PLUGINS {
		if p.id == id {
			return p
		}
	}
	return nil
}

type pluginDeps struct {
	load    func(uid string) M
	store   func(uid string, all M)
	changed func(uid string)
	host    func(uid string) PluginHost
}

type Plugins struct {
	io      pluginDeps
	running *OMap[PluginInst]
}

type errInst struct{ note string }

func (e *errInst) status() M { return M{"state": "error", "note": e.note} }
func (e *errInst) stop()     {}

func newPlugins(io pluginDeps) *Plugins {
	ALL_PLUGINS = []*pluginDef{slackPlugin()}
	return &Plugins{io: io, running: newOMap[PluginInst]()}
}

func pkey(uid, id string) string { return uid + "/" + id }

func (p *Plugins) stopOne(uid, id string) {
	inst, ok := p.running.Get(pkey(uid, id))
	p.running.Delete(pkey(uid, id))
	if ok && inst != nil {
		_ = try(inst.stop)
	}
}

func (p *Plugins) startOne(uid, id string) {
	p.stopOne(uid, id)
	def := pluginByID(id)
	all := p.io.load(uid)
	mine, _ := all[id].(M)
	if def == nil || mine == nil || !truthy(mine["enabled"]) {
		return
	}
	if _, ok := mine["state"].(M); !ok {
		mine["state"] = M{}
	}
	h := &plugHost{PluginHost: p.io.host(uid), state: mine["state"].(M), save: func() { p.io.store(uid, all) }, changed: func() { p.io.changed(uid) }, log: func(t string) { logLine("plugin " + id + " user=" + uid + ": " + t) }}
	config, _ := mine["config"].(M)
	if config == nil {
		config = M{}
	}
	var inst PluginInst
	if err := try(func() { inst = def.start(config, h) }); err != nil {
		inst = &errInst{note: err.Error()}
	}
	p.running.Set(pkey(uid, id), inst)
}

func splitKey(k string) (string, string) {
	i := strings.LastIndex(k, "/")
	return k[:i], k[i+1:]
}

func (p *Plugins) stopAll() {
	for _, k := range p.running.Keys() {
		uid, id := splitKey(k)
		p.stopOne(uid, id)
	}
}

func (p *Plugins) stopUser(uid string) {
	for _, k := range p.running.Keys() {
		u, id := splitKey(k)
		if u == uid {
			p.stopOne(uid, id)
		}
	}
}

func (p *Plugins) startAll(uids []string) {
	for _, uid := range uids {
		for _, id := range sortedKeys(p.io.load(uid)) {
			p.startOne(uid, id)
		}
	}
}

func (p *Plugins) list(uid string) []any {
	all := p.io.load(uid)
	out := []any{}
	for _, def := range ALL_PLUGINS {
		mine, _ := all[def.id].(M)
		cfg := asM(mine["config"])
		config := orderedObj{}
		for _, f := range def.fields {
			if f.secret {
				if truthy(cfg[f.key]) {
					config = append(config, kv{f.key, "••••••••"})
				} else {
					config = append(config, kv{f.key, ""})
				}
			} else if cfg[f.key] != nil {
				config = append(config, kv{f.key, cfg[f.key]})
			} else {
				config = append(config, kv{f.key, ""})
			}
		}
		var status any
		if mine != nil && truthy(mine["enabled"]) {
			if inst, ok := p.running.Get(pkey(uid, def.id)); ok && inst != nil {
				status = inst.status()
			} else {
				status = M{"state": "off", "note": ""}
			}
		} else {
			note := ""
			if mine != nil {
				note = "꺼져 있어요"
			}
			status = M{"state": "off", "note": note}
		}
		fields := []any{}
		for _, f := range def.fields {
			fields = append(fields, f.json())
		}
		out = append(out, orderedObj{{"id", def.id}, {"name", def.name}, {"about", def.about}, {"fields", fields}, {"help", def.help}, {"prompt", def.prompt}, {"added", mine != nil}, {"enabled", mine != nil && truthy(mine["enabled"])}, {"config", config}, {"status", status}})
	}
	return out
}

var dotsOnly = regexp.MustCompile(`^•+$`)

func freshValue(v any, max int) string {
	if max == 0 {
		max = 400
	}
	s, ok := v.(string)
	if !ok || jsTrim(s) == "" || dotsOnly.MatchString(jsTrim(s)) {
		return ""
	}
	return jsSliceTo(jsTrim(s), max)
}

// set: add or change; settings left blank keep what was saved. Returns what was done besides saving.
func (p *Plugins) set(uid, id string, enabled any, config any) []string {
	def := pluginByID(id)
	if def == nil {
		throw("그런 플러그인이 없어요")
	}
	cfgIn := asM(config)
	notes := []string{}
	typed := map[string]string{}
	for _, f := range def.fields {
		typed[f.key] = freshValue(cfgIn[f.key], f.max)
	}
	for _, f := range def.fields {
		v := typed[f.key]
		if f.prefix == "" || v == "" || strings.HasPrefix(v, f.prefix) {
			continue
		}
		for _, o := range def.fields {
			if o.prefix != "" && o.key != f.key && strings.HasPrefix(v, o.prefix) {
				if !strings.HasPrefix(typed[o.key], o.prefix) {
					typed[f.key], typed[o.key] = typed[o.key], v
					notes = append(notes, f.label+"과 "+o.label+"이 바뀌어 있어서 제자리에 넣었어요")
				}
				break
			}
		}
	}
	for _, f := range def.fields {
		if f.prefix != "" && typed[f.key] != "" && !strings.HasPrefix(typed[f.key], f.prefix) {
			throw(f.label + "은 " + f.prefix + " 로 시작해요. 다른 값을 넣지 않았는지 확인해 주세요")
		}
	}
	all := p.io.load(uid)
	mine, _ := all[id].(M)
	if mine == nil {
		mine = M{"enabled": false, "config": M{}, "state": M{}}
		all[id] = mine
	}
	mc, _ := mine["config"].(M)
	if mc == nil {
		mc = M{}
		mine["config"] = mc
	}
	for _, f := range def.fields {
		if typed[f.key] != "" {
			mc[f.key] = typed[f.key]
		} else if cfgIn[f.key] == "" && !f.secret {
			delete(mc, f.key)
		}
	}
	if b, ok := enabled.(bool); ok {
		mine["enabled"] = b
	}
	for _, f := range def.fields {
		if !(truthy(mine["enabled"]) && f.required && f.pick != "" && def.choices != nil && !truthy(mc[f.key])) {
			continue
		}
		var only []any
		_ = try(func() { only = def.choices(shallow(mc), f.key) })
		if len(only) == 1 {
			mc[f.key] = mget(only[0], "value")
			notes = append(notes, f.label+"을 "+jsStringU(mget(only[0], "label"))+"(으)로 정했어요")
		}
	}
	missing := []string{}
	for _, f := range def.fields {
		if f.required && !truthy(mc[f.key]) {
			missing = append(missing, f.label)
		}
	}
	if truthy(mine["enabled"]) && len(missing) > 0 {
		mine["enabled"] = false
		p.io.store(uid, all)
		throw(strings.Join(missing, ", ") + " 을(를) 채워 주세요")
	}
	p.io.store(uid, all)
	p.startOne(uid, id)
	return notes
}

func (p *Plugins) choices(uid, id, key string, draft any) []any {
	def := pluginByID(id)
	ok := false
	if def != nil && def.choices != nil {
		for _, f := range def.fields {
			if f.key == key && f.pick != "" {
				ok = true
			}
		}
	}
	if !ok {
		throw("고를 수 있는 값이 없어요")
	}
	config := shallow(asM(mget(p.io.load(uid)[id], "config")))
	d := asM(draft)
	for _, f := range def.fields {
		if s, ok := d[f.key].(string); ok && jsTrim(s) != "" && !dotsOnly.MatchString(jsTrim(s)) {
			config[f.key] = jsSliceTo(jsTrim(s), 400)
		}
	}
	return def.choices(config, key)
}

func (p *Plugins) remove(uid, id string) {
	p.stopOne(uid, id)
	all := p.io.load(uid)
	delete(all, id)
	p.io.store(uid, all)
}

// event: a session's event, for every plugin that person runs.
func (p *Plugins) event(uid, thread string, ev any) {
	for _, def := range ALL_PLUGINS {
		if inst, ok := p.running.Get(pkey(uid, def.id)); ok {
			if o, ok := inst.(onEventer); ok {
				o.onEvent(thread, ev)
			}
		}
	}
}

// instance: the running copy, or nil.
func (p *Plugins) instance(uid, id string) PluginInst {
	if inst, ok := p.running.Get(pkey(uid, id)); ok {
		return inst
	}
	return nil
}

var _ = sort.Strings
