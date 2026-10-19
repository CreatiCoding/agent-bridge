/**
 * /skills: a read-only view of the private Claude Code skill marketplace (a GitHub repo).
 *
 * The server reads the repo with a read-only token and shows it to signed-in users. Installing still goes
 * through GitHub, so only people with access to the repo can install; this page grants nothing.
 */

import crypto from 'node:crypto'

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
const CHECK_MS = 60_000

/** The files of the /skills feature. Their hash (`codeHash`) says which version of it is deployed, since the image has no git. */
export const SKILLS_FILES = ['server/skills.mjs', 'web/skills.html', 'web/skills.css', 'web/skills.js']

/** sha256 over SKILLS_FILES, first 12 hex. `read(file)` returns the file's contents. */
export function codeHash(read) {
  const h = crypto.createHash('sha256')
  for (const f of SKILLS_FILES) h.update(`${f}\0${read(f)}\0`)
  return h.digest('hex').slice(0, 12)
}

/** `{ repo: 'owner/name', path, ref }` for an entry linked to a folder of a GitHub repo, else null. `ref` is the pinned commit. */
export function upstreamOf(source) {
  if (typeof source !== 'object' || source?.source !== 'git-subdir') return null
  const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(source.url || '')
  return m && { repo: m[1], path: (source.path || '').replace(/^\.?\/+|\/+$/g, ''), ref: source.sha || 'HEAD' }
}

/** Reads the `key: value` and folded (`key: >`) fields of a SKILL.md front matter. */
export function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    let v = kv[2].trim()
    if (/^[>|]-?$/.test(v)) {
      const block = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim())
      v = block.join(v.startsWith('>') ? ' ' : '\n')
    } else if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1)
    meta[kv[1]] = v
  }
  return { meta, body: text.slice(m[0].length) }
}

/** A GitHub App's private key from an environment variable: PEM with real or `\n` newlines, or that PEM in base64. */
export function appKey(text) {
  const s = String(text || '').trim()
  const pem = s.includes('BEGIN') ? s.replace(/\\n/g, '\n') : Buffer.from(s, 'base64').toString('utf8')
  return crypto.createPrivateKey(pem)
}

/** The App's own JWT (RS256): issued a minute back for clock skew, good for 9 minutes (GitHub allows 10). */
export function appJwt(appId, key, now = Date.now()) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const iat = Math.floor(now / 1000) - 60
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat, exp: iat + 600, iss: String(appId) })}`
  return `${body}.${crypto.sign('sha256', Buffer.from(body), key).toString('base64url')}`
}

/** Renew an installation token this long before GitHub says it expires (it lasts an hour). */
const TOKEN_EARLY_MS = 5 * 60_000

/**
 * `app: { id, key }` reads the repo as a GitHub App installed on it: each hour-long installation token is made from
 * the App's key, limited to this repo and Contents read, so nothing here has to be renewed by hand. Without it,
 * `token` (a fine-grained token) is used as before.
 */
export function createSkills({ token, app = null, repo, api = API, raw = RAW, log = () => {} }) {
  let cache = null
  let checkedAt = 0
  let loading = null
  let minted = null // { token, until } of the App's installation
  let minting = null

  const gh = (url, auth, init = {}) =>
    fetch(url, { ...init, headers: { Authorization: `Bearer ${auth}`, 'User-Agent': 'claude-bridge', 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json', ...init.headers } })

  async function mint() {
    const jwt = appJwt(app.id, app.key)
    const inst = await gh(`${api}/repos/${repo}/installation`, jwt)
    if (!inst.ok) throw new Error(`GitHub App 이 ${repo} 에 설치되지 않았어요: GitHub ${inst.status}`)
    const { id } = await inst.json()
    const r = await gh(`${api}/app/installations/${id}/access_tokens`, jwt, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositories: [repo.split('/')[1]], permissions: { contents: 'read', metadata: 'read' } }),
    })
    if (!r.ok) throw new Error(`설치 토큰을 받지 못했어요: GitHub ${r.status}`)
    const t = await r.json()
    log(`skills: GitHub App 설치 토큰 받음 (${t.expires_at} 까지)`)
    return { token: t.token, until: Date.parse(t.expires_at) - TOKEN_EARLY_MS }
  }
  const auth = async () => {
    if (!app) return token
    if (minted && Date.now() < minted.until) return minted.token
    minting ??= mint()
      .then((m) => (minted = m))
      .finally(() => (minting = null))
    return (await minting).token
  }

  const get = async (p, raw = false) => {
    const r = await gh(`${api}/repos/${repo}${p}`, await auth(), { headers: raw ? { Accept: 'application/vnd.github.raw+json' } : {} })
    if (r.status === 401) minted = null // revoked or expired early: the next read makes a new one
    if (!r.ok) throw new Error(`${p}: GitHub ${r.status}`)
    return raw ? r.text() : r.json()
  }
  const file = (ref, p) => get(`/contents/${p}?ref=${ref}`, true)

  // A skill entry may point at a folder of someone else's public GitHub repo instead of a copy here
  // (`source: { source: 'git-subdir', url, path, sha }`). Its SKILL.md is read at the pinned commit, the one
  // that passed the marketplace's security check and that devices install.
  const rawFile = async ({ repo: from, path, ref }, name) => {
    const url = `${raw}/${from}/${ref}/${path ? `${path}/` : ''}${name}`
    const r = await fetch(url, { headers: { 'User-Agent': 'claude-bridge' } })
    if (!r.ok) throw new Error(`${url}: ${r.status}`)
    return r.text()
  }

  // An entry with `outputStyles` ships output styles instead of a skill: show each style file in turn.
  async function styles(up, p) {
    const parts = await Promise.all(p.outputStyles.map(async (f) => frontMatter(await rawFile(up, f.replace(/^\.\//, '')))))
    return {
      meta: { description: parts.map((x) => `${x.meta.name}: ${x.meta.description}`).join(' / ') },
      body: parts.map((x) => `## ${x.meta.name}\n\n${x.body.trim()}\n`).join('\n'),
      styles: parts.map((x) => `${p.name}:${x.meta.name}`),
    }
  }

  async function skill(sha, root, p) {
    const up = upstreamOf(p.source)
    const dir = [root, typeof p.source === 'string' ? p.source.replace(/^\.\//, '') : p.name].filter(Boolean).join('/')
    const { meta, body, styles: outputStyles = [] } =
      up && p.outputStyles?.length ? await styles(up, p) : frontMatter(up ? await rawFile(up, 'SKILL.md') : await file(sha, `${dir}/skills/${p.name}/SKILL.md`))
    return {
      outputStyles,
      name: p.name,
      category: p.category || '',
      keywords: p.keywords || [],
      summary: p.description || '',
      description: meta.description || '',
      argumentHint: meta['argument-hint'] || '',
      allowedTools: meta['allowed-tools'] || '',
      license: meta.license || '',
      upstream: up && { repo: up.repo, sha: up.ref, url: `https://github.com/${up.repo}/tree/${up.ref}/${up.path}` },
      body,
    }
  }

  // The marketplace's daily upstream security check writes its last result here; null when it never ran.
  const lastCheck = () => file('upstream-status', 'status.json').then(JSON.parse, () => null)

  async function load() {
    const [head, check] = await Promise.all([get('/commits/HEAD'), lastCheck()])
    if (cache?.sha === head.sha) return (cache = { ...cache, check })
    const market = JSON.parse(await file(head.sha, '.claude-plugin/marketplace.json'))
    const root = (market.metadata?.pluginRoot || '.').replace(/^\.\/?/, '').replace(/\/+$/, '')
    const skills = await Promise.all(market.plugins.map((p) => skill(head.sha, root, p)))
    const install = await file(head.sha, 'install.sh')
    log(`skills: loaded ${skills.length} from ${repo}@${head.sha.slice(0, 7)}`)
    return (cache = { sha: head.sha, date: head.commit?.committer?.date ?? null, market: market.name, repo, skills, install, check })
  }

  /** The repo at most CHECK_MS old; a failed check keeps serving the last good copy. */
  function current() {
    if (cache && Date.now() - checkedAt < CHECK_MS) return Promise.resolve(cache)
    loading ??= load()
      .then((c) => ((checkedAt = Date.now()), c))
      .catch((e) => {
        log('skills: load failed', e.message)
        if (cache) return (checkedAt = Date.now()), cache
        throw e
      })
      .finally(() => (loading = null))
    return loading
  }

  return { current, auth: app ? 'app' : 'token' }
}
