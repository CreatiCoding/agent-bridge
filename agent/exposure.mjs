// What this machine and its running containers expose (REQ-F-873): the OS, whether sshd listens and how it lets
// people in, and the installed package versions, so a trusted service (autofix, via GET /api/service/hosts) can
// match them against advisories. Read-only, Node's standard library only. Every step has a short timeout, and a step
// that fails is noted in `errors` while the rest goes on. Never sent: environment variables, `docker inspect`'s Env,
// or whole files: only the fields below.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

export const EXPOSURE_FIRST_MS = 60_000
export const EXPOSURE_EVERY_MS = 6 * 3600_000
export const PKG_MAX = 5000
export const CONTAINERS_MAX = 100
export const EXPOSURE_MAX_BYTES = 2 * 1024 * 1024
const ERRORS_MAX = 50
const RUN_MS = 10_000
const BIG_MS = 20_000

const short = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** /etc/os-release as {id, versionId, pretty}; null when it has no ID. */
export function parseOsRelease(text) {
  const v = {}
  for (const line of String(text || '').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    let s = m[2].trim()
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1)
    v[m[1]] = s.replace(/\\(["'$`\\])/g, '$1')
  }
  if (!v.ID) return null
  return { id: short(v.ID.toLowerCase(), 40), versionId: short(v.VERSION_ID, 40), pretty: short(v.PRETTY_NAME || v.NAME, 120), version: v.VERSION || '' }
}

/** The OSV ecosystem name for an OS, "" when there is none worth naming. */
export function ecosystemOf(o) {
  if (!o) return ''
  const ver = o.versionId || ''
  if (o.id === 'ubuntu' && ver) return /LTS/i.test(`${o.version} ${o.pretty}`) ? `Ubuntu:${ver}:LTS` : `Ubuntu:${ver}`
  if (o.id === 'debian' && /^\d+/.test(ver)) return `Debian:${/^\d+/.exec(ver)[0]}`
  if (o.id === 'alpine') {
    const m = /^(\d+)\.(\d+)/.exec(ver)
    if (m) return `Alpine:v${m[1]}.${m[2]}`
  }
  return ''
}

/** The OS as sent: the three contract fields. */
const osOut = (o) => (o ? { id: o.id, versionId: o.versionId, pretty: o.pretty } : null)

/** Deduplicated [name, version] pairs, at most PKG_MAX. */
function pairs(list) {
  const seen = new Set()
  const out = []
  for (const [n, v] of list) {
    const name = short(n, 200)
    const ver = short(v, 200)
    if (!name || !ver) continue
    const k = `${name}\t${ver}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push([name, ver])
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
  return { list: out.slice(0, PKG_MAX), cut: out.length > PKG_MAX }
}

/** /lib/apk/db/installed: each package's origin (o:, else its own name P:) and version (V:). */
export function parseApkInstalled(text) {
  const out = []
  for (const block of String(text || '').split(/\n\s*\n/)) {
    let p = ''
    let o = ''
    let v = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('P:')) p = line.slice(2)
      else if (line.startsWith('o:')) o = line.slice(2)
      else if (line.startsWith('V:')) v = line.slice(2)
    }
    if ((o || p) && v) out.push([o || p, v])
  }
  return pairs(out)
}

/** /var/lib/dpkg/status: source package and its version, for those that are installed. */
export function parseDpkgStatus(text) {
  const out = []
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const f = {}
    for (const line of block.split('\n')) {
      const m = /^([A-Za-z-]+):\s?(.*)$/.exec(line)
      if (m) f[m[1].toLowerCase()] = m[2].trim()
    }
    if (!f.package || !f.version || !/\binstall ok installed\b/.test(f.status || '')) continue
    let name = f.package
    let ver = f.version
    if (f.source) {
      const m = /^(\S+)(?:\s+\(([^)]+)\))?/.exec(f.source)
      if (m) {
        name = m[1]
        if (m[2]) ver = m[2]
      }
    }
    out.push([name, ver])
  }
  return pairs(out)
}

/** `dpkg-query -W -f '${db:Status-Abbrev}\t${source:Package}\t${source:Version}\n'`, installed ones only. */
export function parseDpkgQuery(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const [st, n, v] = line.split('\t')
    if (st?.startsWith('ii') && n && v) out.push([n, v])
  }
  return pairs(out)
}

/**
 * The first regular file in a tar stream (what `docker cp <id>:<file> -` writes), or null. Extended (pax) and GNU
 * long-name headers are stepped over.
 */
export function firstTarFile(buf) {
  let off = 0
  while (buf && off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    if (h.every((b) => b === 0)) return null
    const size = parseInt(h.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) return null
    const type = String.fromCharCode(h[156])
    const start = off + 512
    if (type === '0' || type === '\0') return start + size <= buf.length ? buf.subarray(start, start + size) : null
    off = start + Math.ceil(size / 512) * 512
  }
  return null
}

/** OpenSSH's yes/no words as the contract writes them. */
const PW = (v) => (v === 'yes' || v === 'no' ? v : null)
const ROOT = (v) => (v === 'without-password' ? 'prohibit-password' : ['yes', 'no', 'prohibit-password', 'forced-commands-only'].includes(v) ? v : null)

/** A glob of one path whose last part may have * and ?, sorted as sshd expands it. */
function globFiles(pattern, readdir) {
  const dir = path.dirname(pattern)
  const base = path.basename(pattern)
  if (!/[*?[]/.test(base)) return [pattern]
  const re = new RegExp(`^${base.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  let names = []
  try {
    names = readdir(dir)
  } catch {
    return []
  }
  return names.filter((n) => re.test(n)).sort().map((n) => path.join(dir, n))
}

/**
 * PasswordAuthentication and PermitRootLogin as sshd reads them: the first value wins, Include is read in place, a
 * Match block (until the next Match or the end of that file) is skipped. Not said anywhere: OpenSSH's defaults (yes,
 * prohibit-password). A file it cannot read before a value is known makes that value "unknown".
 */
export function sshdSettings({ file = '/etc/ssh/sshd_config', readFile = (p) => fs.readFileSync(p, 'utf8'), readdir = (d) => fs.readdirSync(d) } = {}) {
  const got = { passwordAuth: null, permitRootLogin: null }
  let blind = false
  let depth = 0
  const done = () => got.passwordAuth && got.permitRootLogin
  const read = (p) => {
    if (done() || depth > 8) return
    let text
    try {
      text = readFile(p)
    } catch {
      blind = true
      return
    }
    depth++
    let inMatch = false
    for (const raw of text.split('\n')) {
      if (done()) break
      const line = raw.replace(/#.*$/, '').trim()
      if (!line) continue
      const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line)
      if (!m) continue
      const key = m[1].toLowerCase()
      const val = m[2].trim().split(/\s+/)[0]?.replace(/^"|"$/g, '').toLowerCase() || ''
      if (key === 'match') {
        inMatch = val !== 'all'
        continue
      }
      if (inMatch) continue
      if (key === 'include') {
        for (const pat of m[2].trim().split(/\s+/)) {
          const full = path.isAbsolute(pat) ? pat : path.join('/etc/ssh', pat)
          for (const f of globFiles(full, readdir)) read(f)
        }
      } else if (key === 'passwordauthentication' && !got.passwordAuth && !blind) got.passwordAuth = PW(val) || 'unknown'
      else if (key === 'permitrootlogin' && !got.permitRootLogin && !blind) got.permitRootLogin = ROOT(val) || 'unknown'
    }
    depth--
  }
  let top = true
  try {
    readFile(file)
  } catch {
    top = false
  }
  if (!top) return { passwordAuth: 'unknown', permitRootLogin: 'unknown', readable: false }
  read(file)
  return {
    passwordAuth: got.passwordAuth || (blind ? 'unknown' : 'yes'),
    permitRootLogin: got.permitRootLogin || (blind ? 'unknown' : 'prohibit-password'),
    readable: !blind,
  }
}

/** Connects to host:port and reads the server's first SSH- line within `ms`. */
export function sshBanner({ host = '127.0.0.1', port = 22, ms = 2000 } = {}) {
  return new Promise((resolve) => {
    let buf = ''
    let connected = false
    let settled = false
    const sock = net.connect({ host, port })
    const end = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(r)
    }
    const timer = setTimeout(() => end({ listening: connected, banner: '', error: connected ? '' : 'ssh: 접속 시간 초과' }), ms)
    sock.on('connect', () => (connected = true))
    sock.on('data', (d) => {
      buf += d.toString('latin1')
      if (buf.length > 4096) return end({ listening: true, banner: '' })
      for (const line of buf.split('\n').slice(0, -1)) {
        if (line.startsWith('SSH-')) return end({ listening: true, banner: line.replace(/\r$/, '').slice(0, 255) })
      }
    })
    sock.on('end', () => end({ listening: connected, banner: '' }))
    sock.on('error', (e) => end({ listening: false, banner: '', error: e.code === 'ECONNREFUSED' ? '' : `ssh: ${e.code || e.message}` }))
  })
}

/** Runs a program without a shell; resolves {ok, out: Buffer, err} and never rejects. */
export function run(file, args, { ms = RUN_MS, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: ms, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', env, windowsHide: true }, (e, out, err) => {
      resolve({ ok: !e, out: out || Buffer.alloc(0), err: e ? short(String(err || '') || e.message, 160) : '' })
    })
  })
}

/** Where a docker CLI may be when the agent runs under launchd or systemd with a short PATH. */
export function dockerCandidates(env = process.env, home = os.homedir()) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean)
  dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/snap/bin', path.join(home, '.docker/bin'), path.join(home, '.colima/bin'), path.join(home, '.rd/bin'), '/Applications/Docker.app/Contents/Resources/bin', '/opt/local/bin')
  return [...new Set(dirs.map((d) => path.join(d, 'docker')))]
}

export function findDocker({ env = process.env, home = os.homedir(), exists = (p) => fs.statSync(p).isFile() } = {}) {
  for (const p of dockerCandidates(env, home)) {
    try {
      if (exists(p)) return p
    } catch {}
  }
  return ''
}

/** `docker ps --format '{{json .}}'` lines as {id, name, image, ports}. */
export function parseDockerPs(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      if (j.ID) out.push({ id: String(j.ID), name: short(j.Names, 200), image: short(j.Image, 300), ports: short(j.Ports, 1000) })
    } catch {}
  }
  return out
}

/** Whether `docker top` lists an sshd process. */
export const topHasSshd = (text) => String(text || '').split('\n').slice(1).some((l) => /(^|[\s/])sshd(:|\s|$)/.test(l))

/**
 * Collects the exposure record. `deps` replaces the world for tests: {platform, readFile, readdir, run, banner,
 * docker, now}.
 */
export async function collectExposure(deps = {}) {
  const platform = deps.platform || process.platform
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'))
  const readdir = deps.readdir || ((d) => fs.readdirSync(d))
  const exec = deps.run || run
  const banner = deps.banner || sshBanner
  const errors = []
  const err = (s) => errors.length < ERRORS_MAX && errors.push(short(s, 300))
  const out = { at: (deps.now || Date.now)(), os: null, ssh: { listening: false, banner: '', passwordAuth: 'unknown', permitRootLogin: 'unknown' }, packages: { ecosystem: '', list: [] }, containers: [], errors }

  // OS
  let osInfo = null
  if (platform === 'darwin') {
    const r = await exec('sw_vers', [])
    if (r.ok) {
      const t = r.out.toString('utf8')
      const get = (k) => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(t) || [])[1]?.trim() || ''
      osInfo = { id: 'macos', versionId: short(get('ProductVersion'), 40), pretty: short(`${get('ProductName') || 'macOS'} ${get('ProductVersion')} (${get('BuildVersion')})`, 120), version: '' }
    } else err(`os: sw_vers ${r.err}`)
  } else {
    try {
      osInfo = parseOsRelease(readFile('/etc/os-release'))
      if (!osInfo) err('os: /etc/os-release 에 ID 가 없음')
    } catch (e) {
      err(`os: /etc/os-release ${e.code || e.message}`)
    }
  }
  out.os = osOut(osInfo)

  // SSH
  const b = await banner({ host: '127.0.0.1', port: 22, ms: 2000 })
  out.ssh.listening = !!b.listening
  out.ssh.banner = b.banner || ''
  if (b.error) err(b.error)
  const sc = sshdSettings({ readFile, readdir })
  out.ssh.passwordAuth = sc.passwordAuth
  out.ssh.permitRootLogin = sc.permitRootLogin
  if (!sc.readable && platform !== 'darwin') err('ssh: sshd_config 를 다 읽지 못함')

  // Host packages (Linux only)
  if (platform === 'linux' && osInfo) {
    const eco = ecosystemOf(osInfo)
    if (osInfo.id === 'alpine') {
      try {
        const p = parseApkInstalled(readFile('/lib/apk/db/installed'))
        out.packages = { ecosystem: eco, list: p.list }
        if (p.cut) err(`packages: ${PKG_MAX}개에서 자름`)
      } catch (e) {
        err(`packages: /lib/apk/db/installed ${e.code || e.message}`)
      }
    } else if (osInfo.id === 'debian' || osInfo.id === 'ubuntu') {
      const r = await exec('dpkg-query', ['-W', '-f', '${db:Status-Abbrev}\t${source:Package}\t${source:Version}\n'], { ms: BIG_MS })
      if (r.ok) {
        const p = parseDpkgQuery(r.out.toString('utf8'))
        out.packages = { ecosystem: eco, list: p.list }
        if (p.cut) err(`packages: ${PKG_MAX}개에서 자름`)
      } else err(`packages: dpkg-query ${r.err}`)
    }
  }

  // Containers
  const docker = deps.docker !== undefined ? deps.docker : findDocker()
  if (docker) await containers(docker, exec, out, err)

  return fit(out, err)
}

async function containers(docker, exec, out, err) {
  // The CLI's own directory first: colima's and Docker Desktop's helpers sit beside it.
  const env = { PATH: [path.dirname(docker), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(path.delimiter), HOME: os.homedir() }
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST
  if (process.env.DOCKER_CONTEXT) env.DOCKER_CONTEXT = process.env.DOCKER_CONTEXT
  const ps = await exec(docker, ['ps', '--format', '{{json .}}'], { env })
  if (!ps.ok) return err(`docker: ps ${ps.err}`)
  let list = parseDockerPs(ps.out.toString('utf8'))
  if (list.length > CONTAINERS_MAX) {
    err(`docker: 컨테이너 ${list.length}개 중 ${CONTAINERS_MAX}개만`)
    list = list.slice(0, CONTAINERS_MAX)
  }
  if (!list.length) return
  // Image ids, so containers of one image read its files once. Only these two fields, never Env.
  const imageOf = {}
  const ins = await exec(docker, ['inspect', '--format', '{{.Id}}\t{{.Image}}', ...list.map((c) => c.id)], { env })
  if (ins.ok) {
    for (const line of ins.out.toString('utf8').split('\n')) {
      const [cid, img] = line.trim().split('\t')
      if (cid && img) for (const c of list) if (cid.startsWith(c.id)) imageOf[c.id] = img
    }
  }
  const cat = async (id, file) => {
    const r = await exec(docker, ['cp', '-L', `${id}:${file}`, '-'], { env, ms: BIG_MS })
    if (!r.ok) return null
    const f = firstTarFile(r.out)
    return f ? f.toString('utf8') : null
  }
  const byImage = new Map()
  for (const c of list) {
    const img = imageOf[c.id] || ''
    let read = img && byImage.get(img)
    if (!read) {
      read = { os: null, packages: { ecosystem: '', list: [] } }
      const o = parseOsRelease((await cat(c.id, '/etc/os-release')) || '')
      read.os = osOut(o)
      if (o) {
        const eco = ecosystemOf(o)
        let p = null
        if (o.id === 'alpine') {
          const t = await cat(c.id, '/lib/apk/db/installed')
          if (t != null) p = parseApkInstalled(t)
        } else {
          const t = await cat(c.id, '/var/lib/dpkg/status')
          if (t != null) p = parseDpkgStatus(t)
        }
        if (p) {
          read.packages = { ecosystem: eco, list: p.list }
          if (p.cut) err(`${c.name}: 패키지 ${PKG_MAX}개에서 자름`)
        }
      }
      if (img) byImage.set(img, read)
    }
    const top = await exec(docker, ['top', c.id], { env })
    out.containers.push({ name: c.name, image: c.image, ports: c.ports, os: read.os, sshd: top.ok && topHasSshd(top.out.toString('utf8')), packages: { ecosystem: read.packages.ecosystem, list: read.packages.list } })
  }
}

/** Under EXPOSURE_MAX_BYTES: the biggest package lists go first (containers, then the host's), noted in errors. */
export function fit(out, err = (s) => out.errors.push(s)) {
  const size = () => Buffer.byteLength(JSON.stringify(out))
  if (size() <= EXPOSURE_MAX_BYTES) return out
  const holders = [...out.containers.map((c) => c.packages), out.packages].filter((p) => p.list.length).sort((a, b) => b.list.length - a.list.length)
  for (const p of holders) {
    p.list = []
    if (size() <= EXPOSURE_MAX_BYTES) break
  }
  err('size: 2MB 를 넘어 패키지 목록을 비움')
  if (size() > EXPOSURE_MAX_BYTES) out.containers = out.containers.slice(0, 10)
  return out
}

/** One collection at a time: a call while one runs gets that run's promise. */
export class ExposureRunner {
  constructor(collect = collectExposure) {
    this.collect = collect
    this.running = null
    this.last = null
    this.sent = false
  }
  run() {
    if (!this.running) {
      this.running = Promise.resolve()
        .then(() => this.collect())
        .then((r) => {
          this.last = r
          this.sent = false
          return r
        })
        .finally(() => (this.running = null))
    }
    return this.running
  }
}
