// Replacing the server without a gap. Two copies of the server share one data folder for a few seconds while a
// deploy swaps them (the new one is started before the old one is stopped). They must never both own the state:
//
//   new: sees a live server in the data folder → asks for the state → waits
//   old: finishes what it is doing, writes everything to disk, stops writing, holds incoming requests → says "done"
//   new: loads the state, starts listening → says "ready"
//   old: passes every request, held and new, on to the new one until it is stopped
//
// Nothing a browser or an agent sent is refused or lost on the way: at worst it waits the fraction of a second the
// new server needs to load. When no other server is alive (a cold start, or a deploy that stops the old one first)
// none of this happens and the server starts at once.
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'

const ALIVE_MS = 1500
/** A server that has not said it is alive for this long is gone. */
const GONE_MS = 5000
const ANSWER_MS = 20_000
const READY_MS = 25_000
const POLL_MS = 150
/** How long a server that passes requests on stays up after being told to stop: the router still sends it some. */
const LINGER_MS = 8000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const write = (file, v) => {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * @param {string} dir the data folder both servers see
 * @param {(...a: unknown[]) => void} log
 */
export function createHandover(dir, log) {
  const id = crypto.randomBytes(6).toString('hex')
  const aliveFile = path.join(dir, 'instance.json')
  const talkFile = path.join(dir, 'handover.json')
  // What a passed-on request carries: a secret only servers sharing this data folder know, so a request from outside
  // cannot skip the wait by naming the header (R1-L4). Made once by whichever server comes first.
  const secretFile = path.join(dir, 'handover.secret')
  let secret
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(secretFile, crypto.randomBytes(24).toString('hex'), { flag: 'wx', mode: 0o600 })
  } catch {}
  try {
    secret = fs.readFileSync(secretFile, 'utf8').trim()
  } catch {
    secret = crypto.randomBytes(24).toString('hex')
  }
  /** 'running' | 'draining' (requests wait) | 'proxy' (requests go to the new server) */
  let state = 'running'
  let target = null
  let release = () => {}
  let waiting = Promise.resolve()
  let tookOver = false
  /** What the old server passed along with its state (which Macs were connected), for the new one to wait on. */
  let carried = null

  /**
   * Before any state is read. Resolves once this server may load the data folder as its own.
   * @returns {Promise<boolean>} whether a live server handed its state over
   */
  async function takeOver() {
    fs.mkdirSync(dir, { recursive: true })
    const other = read(aliveFile)
    if (!other || other.id === id || Date.now() - other.at > GONE_MS) return false
    log(`handover: asking the running server (${other.id}) for the state`)
    write(talkFile, { step: 'request', from: id, to: other.id, at: Date.now() })
    const until = Date.now() + ANSWER_MS
    while (Date.now() < until) {
      await sleep(POLL_MS)
      const t = read(talkFile)
      if (t?.step === 'done' && t.to === id) {
        log('handover: the running server wrote its state and stopped writing')
        carried = t.carry ?? null
        return (tookOver = true)
      }
      // It was stopped meanwhile (a deploy that stops the old one first): what is on disk is final.
      const alive = read(aliveFile)
      if (!alive || alive.id !== other.id || Date.now() - alive.at > GONE_MS) {
        log('handover: the running server is gone; starting from what is on disk')
        return false
      }
    }
    log('handover: no answer from the running server; starting from what is on disk')
    return false
  }

  /** Where the old server can reach this one: every address of this container, to be tried in turn. */
  const addresses = () =>
    Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => a.address)

  function probe(host, port) {
    return new Promise((resolve) => {
      const req = http.get({ host, port, path: '/api/health', timeout: 1500 }, (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).instance)
          } catch {
            resolve(null)
          }
        })
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => (req.destroy(), resolve(null)))
    })
  }

  /**
   * After the server listens. Says "alive", and gives the state away when a newer server asks.
   * @param {{ port: number, drain: () => Promise<object | void>, resume: () => Promise<void> | void, cut: () => void }} hooks
   *   drain: finish, write everything, stop writing. resume: take the state back (the new server never came).
   *   cut: end the long-lived streams so their clients reconnect, through this server, to the new one.
   */
  function serve({ port, drain, resume, cut }) {
    const beat = () => state !== 'proxy' && write(aliveFile, { id, at: Date.now(), pid: process.pid })
    beat()
    const beating = setInterval(beat, ALIVE_MS)
    beating.unref()
    if (tookOver) write(talkFile, { step: 'ready', from: id, addrs: addresses(), port, at: Date.now() })

    const watching = setInterval(async () => {
      if (state !== 'running') return
      const t = read(talkFile)
      if (t?.step !== 'request' || t.to !== id || Date.now() - t.at > ANSWER_MS) return
      state = 'draining'
      waiting = new Promise((r) => (release = r))
      log(`handover: a newer server (${t.from}) asked for the state; finishing and writing it`)
      let carry = null
      try {
        carry = (await drain()) ?? null
      } catch (e) {
        log('handover: drain failed', e)
      }
      write(talkFile, { step: 'done', from: id, to: t.from, at: Date.now(), carry })
      const until = Date.now() + READY_MS
      while (Date.now() < until) {
        await sleep(POLL_MS)
        const r = read(talkFile)
        if (r?.step !== 'ready' || r.from !== t.from) continue
        for (const host of r.addrs) {
          if ((await probe(host, r.port)) !== t.from) continue
          target = { host, port: r.port }
          state = 'proxy'
          log(`handover: the new server is up at ${host}:${r.port}; passing requests on to it`)
          release()
          cut()
          return
        }
      }
      // The new server never came up. This one is still whole: carry on as before.
      log('handover: the new server did not come up; taking the state back')
      await resume()
      state = 'running'
      beat()
      release()
    }, POLL_MS * 2)
    watching.unref()

    const bye = () => {
      if (state !== 'proxy' && read(aliveFile)?.id === id) fs.rmSync(aliveFile, { force: true })
    }
    process.on('exit', bye)
  }

  /**
   * First thing for every request. True when the request was passed on to the new server.
   * A request that arrives while the state is being written waits; nothing is answered with an error.
   */
  async function intercept(req, res) {
    if (req.headers['x-bridge-handover'] === secret) {
      // Used up here: nothing after this (the preview proxy to a local app) passes the secret on (R3-L1).
      delete req.headers['x-bridge-handover']
      return false
    }
    if (state === 'running') return false
    if (state === 'draining') await waiting
    if (state !== 'proxy') return false
    const up = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, 'x-bridge-handover': secret } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Retry-After': '1' })
      res.end()
    })
    res.on('close', () => up.destroy())
    req.pipe(up)
    return true
  }

  /**
   * On a stop signal: how long to stay. While a newer server is being swapped in (this one is passing requests on,
   * or still writing the state for it) the router keeps sending requests here for a moment after the stop was
   * ordered; a process that quits at once turns each of those into a 502. Alone, there is nothing to wait for.
   */
  const linger = () => (state === 'running' ? 0 : LINGER_MS)

  return { id, takeOver, serve, intercept, linger, state: () => state, carried: () => carried }
}
