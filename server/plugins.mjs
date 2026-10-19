// Plugins: things a person adds to their own bridge and takes out again, without the rest knowing.
// A plugin is one file in server/plugins/ that exports { id, name, about, fields, help, start(config, host) }.
// Each person has their own settings and their own running copy: one person's Slack app and channel are not
// another's. Turning one off stops it; removing it forgets its settings and what it kept.
import slack from './plugins/slack.mjs'

const ALL = [slack]
const byId = (id) => ALL.find((p) => p.id === id)

/**
 * @param io what the server lends: { load(uid) → saved object, store(uid, obj), host(uid) → the calls a plugin
 *           may make for that person, log, changed(uid) }
 */
export function plugins(io) {
  const running = new Map() // `${uid}/${id}` → what start() returned
  const key = (uid, id) => `${uid}/${id}`
  const saved = (uid) => io.load(uid)

  async function stop(uid, id) {
    const inst = running.get(key(uid, id))
    running.delete(key(uid, id))
    try {
      await inst?.stop?.()
    } catch {}
  }
  async function start(uid, id) {
    await stop(uid, id)
    const def = byId(id)
    const all = saved(uid)
    const mine = all[id]
    if (!def || !mine?.enabled) return
    mine.state ??= {}
    const host = { ...io.host(uid), state: mine.state, save: () => io.store(uid, all), changed: () => io.changed(uid), log: (t) => io.log(`plugin ${id} user=${uid}: ${t}`) }
    try {
      running.set(key(uid, id), await def.start(mine.config ?? {}, host))
    } catch (e) {
      running.set(key(uid, id), { status: () => ({ state: 'error', note: e.message }), stop() {} })
    }
  }

  return {
    /** Before this server gives its place to another: nothing of it may keep talking to the outside. */
    stopAll: () => Promise.all([...running.keys()].map((k) => stop(k.slice(0, k.lastIndexOf('/')), k.slice(k.lastIndexOf('/') + 1)))),
    /** 계정 삭제 (REQ-F-770): one person's running plugins stop; their settings go with the account's folder. */
    stopUser: (uid) => Promise.all([...running.keys()].filter((k) => k.slice(0, k.lastIndexOf('/')) === uid).map((k) => stop(uid, k.slice(k.lastIndexOf('/') + 1)))),
    /** At boot: everyone's enabled plugins. */
    startAll: (uids) => Promise.all(uids.flatMap((uid) => Object.keys(saved(uid)).map((id) => start(uid, id)))),
    /** What the settings page shows. A secret is never sent back, only whether one is set. */
    list(uid) {
      const all = saved(uid)
      return ALL.map((def) => {
        const mine = all[def.id]
        const config = Object.fromEntries(def.fields.map((f) => [f.key, f.secret ? (mine?.config?.[f.key] ? '••••••••' : '') : (mine?.config?.[f.key] ?? '')]))
        const status = mine?.enabled ? (running.get(key(uid, def.id))?.status?.() ?? { state: 'off', note: '' }) : { state: 'off', note: mine ? '꺼져 있어요' : '' }
        return { id: def.id, name: def.name, about: def.about, fields: def.fields, help: def.help, prompt: def.prompt, added: !!mine, enabled: !!mine?.enabled, config, status }
      })
    },
    /**
     * Add or change: settings left blank keep what was saved, so a secret need not be typed again. A field with a
     * `prefix` takes only values that start with it; two such values typed into each other's box are put back
     * where they belong. A required field that can be picked and is left blank is filled when there is only one
     * thing to pick. Returns what was done for the person besides saving (said in the toast).
     */
    async set(uid, id, { enabled, config }) {
      const def = byId(id)
      if (!def) throw new Error('그런 플러그인이 없어요')
      const notes = []
      const fresh = (v, max = 400) => (typeof v === 'string' && v.trim() && !/^•+$/.test(v.trim()) ? v.trim().slice(0, max) : '')
      const typed = Object.fromEntries(def.fields.map((f) => [f.key, fresh(config?.[f.key], f.max)]))
      for (const f of def.fields) {
        const v = typed[f.key]
        if (!f.prefix || !v || v.startsWith(f.prefix)) continue
        const other = def.fields.find((o) => o.prefix && o !== f && v.startsWith(o.prefix))
        if (other && !typed[other.key]?.startsWith(other.prefix)) {
          ;[typed[f.key], typed[other.key]] = [typed[other.key], v]
          notes.push(`${f.label}과 ${other.label}이 바뀌어 있어서 제자리에 넣었어요`)
        }
      }
      const wrong = def.fields.find((f) => f.prefix && typed[f.key] && !typed[f.key].startsWith(f.prefix))
      if (wrong) throw new Error(`${wrong.label}은 ${wrong.prefix} 로 시작해요. 다른 값을 넣지 않았는지 확인해 주세요`)
      const all = saved(uid)
      const mine = (all[id] ??= { enabled: false, config: {}, state: {} })
      for (const f of def.fields) {
        if (typed[f.key]) mine.config[f.key] = typed[f.key]
        else if (config?.[f.key] === '' && !f.secret) delete mine.config[f.key]
      }
      if (typeof enabled === 'boolean') mine.enabled = enabled
      for (const f of def.fields.filter((f) => mine.enabled && f.required && f.pick && def.choices && !mine.config[f.key])) {
        const only = await def.choices({ ...mine.config }, f.key).catch(() => [])
        if (only.length === 1) {
          mine.config[f.key] = only[0].value
          notes.push(`${f.label}을 ${only[0].label}(으)로 정했어요`)
        }
      }
      const missing = def.fields.filter((f) => f.required && !mine.config[f.key])
      if (mine.enabled && missing.length) {
        mine.enabled = false
        io.store(uid, all)
        throw new Error(`${missing.map((f) => f.label).join(', ')} 을(를) 채워 주세요`)
      }
      io.store(uid, all)
      await start(uid, id)
      return { notes }
    },
    /** What a field can be picked from (Slack: the channels its bot is in), with what is saved and what is typed. */
    async choices(uid, id, key, draft) {
      const def = byId(id)
      if (!def?.choices || !def.fields.some((f) => f.key === key && f.pick)) throw new Error('고를 수 있는 값이 없어요')
      const config = { ...(saved(uid)[id]?.config ?? {}) }
      for (const f of def.fields) {
        const v = draft?.[f.key]
        if (typeof v === 'string' && v.trim() && !/^•+$/.test(v.trim())) config[f.key] = v.trim().slice(0, 400)
      }
      return def.choices(config, key)
    },
    async remove(uid, id) {
      await stop(uid, id)
      const all = saved(uid)
      delete all[id]
      io.store(uid, all)
    },
    /** A session's event, for every plugin that person runs. */
    event(uid, thread, ev) {
      for (const def of ALL) running.get(key(uid, def.id))?.onEvent?.(thread, ev)
    },
    instance: (uid, id) => running.get(key(uid, id)),
  }
}
