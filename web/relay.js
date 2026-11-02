// The relay: the only link between this Mac's local agent (127.0.0.1) and the web server.
// It moves messages both ways without interpreting them, except attaching the transcript to an `open` and the
// agent's new files to an `update`. Any page of the site can run it: the bridge page shows what it is doing, the
// control page runs it in the background, so the Mac is connected while either is open in its browser.
const AGENT_KEY = 'cb.agent'

/** The agent's port and key, as left in this browser by the link the agent opened. null on any other device. */
export function agentInfo() {
  try {
    const a = JSON.parse(localStorage.getItem(AGENT_KEY))
    return a?.key ? a : null
  } catch {
    return null
  }
}
export function saveAgentInfo(port, key) {
  localStorage.setItem(AGENT_KEY, JSON.stringify({ port: Number(port) || 4317, key }))
}

/**
 * Whether an answer to one of the relay's own requests (redirect: 'manual') came from a sign-in gate instead of this
 * server (REQ-F-833): sent on to another address (the proxy's sign-in page), 401, or a page where JSON was asked.
 * The reason in a few words, or null.
 */
export function turnedAway(r) {
  if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) return '요청이 다른 주소로 넘어감(프록시 로그인 페이지)'
  if (r.status === 401) return 'HTTP 401'
  if (r.ok && /^text\/html/i.test(r.headers.get('content-type') || '')) return 'JSON 대신 HTML 응답'
  return null
}

/**
 * @param {object} ui what the page wants to hear about; every callback is optional.
 *   link(which: 'agent'|'server', state: 'on'|'wait'|'off', text)   the state of one side
 *   log(text)                                                         a line for the page's own log
 *   hello(msg)                                                        the agent introduced itself
 *   agentOpen() / agentError({ perm, safari })                        the connection to 127.0.0.1
 *   stood(text, offerTakeover)                                        this tab stopped relaying
 *   login(why)                                                        the sign-in has expired
 * @param {{ takeover?: boolean, persistent?: boolean, confirmLeave?: boolean, background?: boolean }} opts
 *   takeover: go ahead of a tab that is already relaying (a tab the agent itself just opened).
 *   persistent: after standing down, wait in line again instead of staying stopped (the control page).
 *   confirmLeave: ask before this tab is closed or navigated away while it relays (the bridge page).
 *   background: this tab is the agent's own headless browser (헤드리스 연동 모드): the agent lets it hold the link.
 */
export function startRelay(ui = {}, opts = {}) {
  const agent = agentInfo()
  /** The last thing said about each side, kept for the status this tab reports about itself. */
  const said = { agent: '', server: '' }
  const link = (which, st, text) => ((said[which] = `${st}: ${text}`), ui.link?.(which, st, text))
  const log = (text) => ui.log?.(text)
  if (!agent) return link('agent', 'off', '연결 정보 없음')
  // Another tab of this browser took a new key from the agent (rekey below): this one uses it too from now on.
  addEventListener('storage', (e) => {
    if (e.key !== AGENT_KEY) return
    const next = agentInfo()
    if (next?.key) Object.assign(agent, next)
  })
  /** Identifies this tab to the agent, so its own reconnects are not mistaken for another tab taking over. */
  const TAB = crypto.randomUUID()

  let hostId = null
  /** Proof to the server that this tab is the host's current bridge. A newer tab's hello replaces it. */
  let conn = null
  let agentStream = null
  let serverStream = null
  let serverReady = false
  let stopped = true
  const queue = []
  let pumping = false

  /** What this relay has moved and where it failed; sent to the server so a stuck tab can be told from a dead agent. */
  /** The server's web files as this tab first heard of them: a different one later means a deploy. */
  let webSeen = null
  const diag = { fromServer: 0, toAgentOk: 0, toAgentFail: 0, fromAgent: 0, upOk: 0, upFail: 0, agentReconnects: 0, lastError: null }
  const fail = (text) => (diag.lastError = { ts: Date.now(), text: String(text).slice(0, 200) })
  const agentUrl = (p) => `http://127.0.0.1:${agent.port}${p}${p.includes('?') ? '&' : '?'}key=${encodeURIComponent(agent.key)}`

  /**
   * The sign-in is gone (turnedAway). The headless browser's page also tells the agent, once: the server cannot be
   * told through this tab any more, the agent shows it and lets a visible tab of the site carry it (REQ-F-833).
   */
  let loginSaid = false
  function loginLost(why) {
    if (opts.background && !loginSaid) {
      loginSaid = true
      log(`로그인이 필요함: ${why}`)
      fetch(agentUrl(`/login-state?tab=${TAB}`), { method: 'POST', body: JSON.stringify({ required: true, why }) }).catch(() => {})
    }
    return ui.login?.(why)
  }

  /** A failure in the relay itself goes to the server's log for this host, next to the agent's own lines. */
  function report(level, area, text) {
    log(text)
    if (level !== 'info') fail(text)
    if (hostId) (queue.push({ t: 'logs', src: 'page', entries: [{ ts: Date.now(), level, area, text }] }), pump())
  }

  /**
   * Hand a command to the agent. A plain-text POST with the key in the address needs no CORS preflight,
   * which is one request fewer that the browser can refuse on the way to 127.0.0.1.
   */
  async function toAgent(cmd) {
    if (cmd.t === 'open') {
      // Only a real copy is handed over: an error page (a sign-in that just ran out) must never become the transcript.
      const r = await fetch(`/api/bridge/transcript?${new URLSearchParams({ sid: cmd.sid, hostId, conn })}`)
      if (!r.ok) throw new Error(`대화 사본을 받지 못함 (HTTP ${r.status})`)
      // 204: none passing through, the Mac opens its own copy (a reopen, another account there).
      if (r.status !== 204) cmd.transcript = await r.text()
    }
    // The agent never fetches anything itself: its new files come through this tab, like everything else.
    if (cmd.t === 'update') {
      cmd.files = {}
      for (const name of cmd.names) {
        const r = await fetch(`/agent/${name}`, { cache: 'no-store' })
        if (!r.ok) throw new Error(`${name} 을 받지 못함 (HTTP ${r.status})`)
        cmd.files[name] = await r.text()
      }
    }
    // Videos and other files sent with a message (REQ-F-761, REQ-F-830) are too big to ride in it: each is fetched here and handed to the agent
    // on its own, and the message then names where the agent put it. Sent without a type, like the commands, so
    // the browser asks no preflight on the way to 127.0.0.1.
    if (cmd.t === 'send' && Array.isArray(cmd.videos)) {
      for (const v of cmd.videos) {
        const got = await fetch(`/api/bridge/upload?${new URLSearchParams({ id: v.id, hostId, conn })}`)
        if (!got.ok) throw new Error(`영상·파일을 받지 못함 (HTTP ${got.status})`)
        const put = await fetch(agentUrl(`/file?${new URLSearchParams({ sid: cmd.sid, id: v.id, name: v.name })}`), { method: 'POST', body: (await got.blob()).slice(0, undefined, ''), signal: AbortSignal.timeout(600_000) })
        const j = await put.json().catch(() => ({}))
        if (!put.ok || !j.path) throw new Error(`에이전트가 영상·파일을 받지 못함 (HTTP ${put.status})`)
        v.path = j.path
      }
    }
    const r = await fetch(agentUrl(`/cmd?tab=${TAB}`), { method: 'POST', body: JSON.stringify(cmd), signal: AbortSignal.timeout(cmd.t === 'open' ? 120_000 : 10_000) })
    if (!r.ok) throw new Error(`에이전트가 HTTP ${r.status} 로 거절`)
  }

  /**
   * A command for the agent, sent again while the agent is not there to take it (it restarts for an update, or
   * launchd brings it back): only when the connection itself failed, so the command cannot have arrived. For up
   * to AGENT_BACK_MS, waiting together with the commands behind it so their order stays; only after that does the
   * server hear the command failed. A slow answer (time-out) or a refusal from the agent is not sent again.
   */
  const AGENT_BACK_MS = 30_000
  let agentBack = null
  const unreachable = (err) => err instanceof TypeError
  function waitForAgent() {
    if (agentBack) return agentBack
    agentBack = (async () => {
      const until = Date.now() + AGENT_BACK_MS
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 500))
        const ok = await fetch(agentUrl('/ping'), { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)
        if (ok) return true
      }
      return false
    })().finally(() => setTimeout(() => (agentBack = null), 0))
    return agentBack
  }
  async function toAgentAgain(cmd) {
    if (agentBack) await agentBack
    try {
      return await toAgent(cmd)
    } catch (err) {
      if (!unreachable(err)) throw err
      report('info', 'relay', `${cmd.t}: 에이전트에 닿지 않음 — 다시 뜨기를 기다렸다가 보냄`)
      if (!(await waitForAgent())) throw new Error(`에이전트가 ${AGENT_BACK_MS / 1000}초 동안 돌아오지 않았습니다`)
      return toAgent(cmd)
    }
  }

  /** Send queued agent messages to the server in order. A failed batch is retried, never skipped. */
  async function pump() {
    if (pumping || !serverReady) return
    pumping = true
    try {
      while (queue.length && serverReady) {
        const batch = []
        let size = 0
        while (queue.length && size < 1024 * 1024) {
          size += JSON.stringify(queue[0]).length
          batch.push(queue.shift())
        }
        try {
          const r = await fetch('/api/bridge/up', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostId, conn, msgs: batch }), signal: AbortSignal.timeout(30_000), redirect: 'manual' })
          const away = turnedAway(r)
          if (away) return loginLost(away)
          if (r.status === 409) return standDown('다른 탭이나 브라우저가 연동을 넘겨받음')
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          diag.upOk++
        } catch (e) {
          diag.upFail++
          fail(`서버로 보내지 못함: ${e.message}`)
          queue.unshift(...batch)
          log(`서버로 보내지 못함 (${e.message}), 다시 시도`)
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    } finally {
      pumping = false
    }
  }

  // ---- the server's way down: a stream, or fetching when a proxy holds streams back (REQ-F-849) ----
  /** A stream must bring its first message (the server's 'web') this soon; the server pings every 15 s after. */
  const DOWN_FIRST_MS = 10_000
  const DOWN_STALL_MS = 40_000
  /** This many failed stream attempts in a row, while the server answers plain requests, and the tab fetches. */
  const DOWN_FAILS = 2
  const PROBE_FIRST_MS = 60_000
  const PROBE_MAX_MS = 15 * 60_000
  const PROBE_RESET_MS = 10 * 60_000
  let downMode = 'sse'
  let downFails = 0
  let downFirst = false
  /** When the stream brought its first message: only one that then stays well a while clears the failures. */
  let downLiveAt = 0
  let downTimer = 0
  let serverHeard = 0
  let downRun = 0
  let downAbort = null
  let probeDelay = PROBE_FIRST_MS
  let streamSince = 0
  let checkingDown = false
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** Stop listening to the server, whichever way. */
  function closeDown() {
    serverStream?.close()
    serverStream = null
    clearTimeout(downTimer)
    downRun++
    downAbort?.abort()
  }

  /** The server is reachable on this link (first message, or a fetch answered). */
  function serverUp(fresh) {
    const again = serverReady === null || (fresh && serverReady === true)
    serverReady = true
    link('server', 'on', downMode === 'poll' ? '연결됨 (스트림이 막혀 폴링)' : '연결됨')
    // After a dropped connection the server has forgotten this host's state: have the agent introduce itself again.
    if (again) toAgent({ t: 'rehello' }).catch(() => {})
    pump()
  }

  function fromServer(cmd) {
    serverHeard = Date.now()
    if (cmd.t === 'replaced') return standDown('다른 탭이나 브라우저가 연동을 넘겨받음')
    // The server's web files changed (a deploy): this tab runs the new relay by reloading once (REQ-F-761).
    if (cmd.t === 'web') {
      if (webSeen && cmd.hash && cmd.hash !== webSeen) return location.reload()
      webSeen = cmd.hash || webSeen
      return
    }
    diag.fromServer++
    if (cmd.t !== 'welcome' && cmd.t !== 'ping') log(`← ${cmd.t}`)
    // The server waits on commands that carry a reqId: tell it at once that the tab has it, and at once if the agent cannot be reached.
    if (cmd.reqId) (queue.push({ t: 'got', reqId: cmd.reqId }), pump())
    toAgentAgain(cmd).then(
      () => diag.toAgentOk++,
      (err) => {
        diag.toAgentFail++
        report('error', 'relay', `${cmd.t} 를 에이전트로 전달하지 못함: ${err.message}`)
        if (cmd.reqId) (queue.push({ t: 'relayfail', reqId: cmd.reqId, error: err.message }), pump())
      },
    )
  }

  function connectServer() {
    if (downMode === 'poll') return void startDownPoll()
    closeDown()
    if (serverReady !== null) serverReady = false
    downFirst = false
    // gen: this attempt; a late request of an older one (stream or fetch) must not replace it on the server.
    const es = (serverStream = new EventSource(`/api/bridge/stream?hostId=${hostId}&conn=${conn}&gen=${downRun}`))
    const firstLate = () => es === serverStream && !downFirst && downFailed('첫 메시지가 오지 않음')
    downTimer = setTimeout(firstLate, DOWN_FIRST_MS)
    es.onopen = () => {
      if (es !== serverStream) return
      serverUp(false)
    }
    es.onmessage = (e) => {
      if (es !== serverStream) return
      if (!downFirst) {
        downFirst = true
        downLiveAt = Date.now()
        clearTimeout(downTimer)
      }
      fromServer(JSON.parse(e.data))
    }
    es.onerror = () => {
      if (es !== serverStream) return
      // 409: the server no longer takes this tab as the host's bridge. EventSource does not retry that. A proxy
      // that refuses or cuts streams ends one the same way: an empty send up tells them apart.
      if (es.readyState === EventSource.CLOSED || !downFirst) return void downFailed(downFirst ? '스트림이 닫힘' : '스트림이 열리지 않음')
      serverReady = null
      link('server', 'wait', '다시 연결하는 중')
      // The browser reconnects by itself: that stream must bring its first message in time too.
      downFirst = false
      clearTimeout(downTimer)
      downTimer = setTimeout(firstLate, DOWN_FIRST_MS)
    }
  }

  /** Whether this tab is still the host's bridge and signed in: an empty send up answers that, and nothing else. */
  async function stillBridge() {
    const r = await fetch('/api/bridge/up', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostId, conn, msgs: [] }), signal: AbortSignal.timeout(8000), redirect: 'manual' }).catch(() => null)
    if (!r) return 'down'
    const away = turnedAway(r)
    if (away) return void loginLost(away)
    if (r.status === 409 || r.status === 404) return void standDown('서버가 이 탭의 연동을 받지 않음 — 새로고침해 주세요')
    return r.ok ? 'ok' : 'down'
  }

  /** A stream attempt failed: tell a blocked stream from a server that is down, and fetch after a few. */
  async function downFailed(why) {
    if (checkingDown || stopped || downMode === 'poll') return
    checkingDown = true
    serverStream?.close()
    serverStream = null
    clearTimeout(downTimer)
    serverReady = null
    link('server', 'wait', '다시 연결하는 중')
    try {
      const was = conn
      const st = await stillBridge()
      if (!st || stopped || conn !== was) return
      // The server itself does not answer (a deploy, no network): not the stream's fault.
      if (st === 'ok' && navigator.onLine) downFails++
      if (downFails >= DOWN_FAILS) {
        report('warn', 'relay', `서버 스트림이 이 네트워크에서 막혀 폴링으로 받음 (${why})`)
        if (streamSince && Date.now() - streamSince > PROBE_RESET_MS) probeDelay = PROBE_FIRST_MS
        downMode = 'poll'
        startDownPoll()
      } else setTimeout(() => !stopped && conn === was && connectServer(), st === 'ok' ? 1000 : 3000)
    } finally {
      checkingDown = false
    }
  }

  function startDownPoll() {
    closeDown()
    void downPoll(downRun, conn)
  }

  async function downPoll(run, myConn) {
    let since = 0
    let longOk = true
    let errs = 0
    let first = true
    let probeAt = Date.now() + probeDelay
    while (run === downRun && !stopped && conn === myConn) {
      if (Date.now() >= probeAt) {
        if (await probeStream()) {
          if (run !== downRun || stopped) return
          report('info', 'relay', '서버 스트림이 다시 통해 스트림으로 돌아감')
          downMode = 'sse'
          downFails = 0
          streamSince = Date.now()
          serverReady = null
          connectServer()
          return
        }
        probeDelay = Math.min(probeDelay * 2, PROBE_MAX_MS)
        probeAt = Date.now() + probeDelay
      }
      const wait = longOk ? 20 : 0
      downAbort = new AbortController()
      let pause = longOk ? 0 : 1000
      try {
        const r = await fetch(`/api/bridge/poll?${new URLSearchParams({ hostId, conn: myConn, since, wait, gen: run })}`, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.any([downAbort.signal, AbortSignal.timeout(wait * 1000 + 15_000)]) })
        if (run !== downRun) return
        const away = turnedAway(r)
        if (away) return loginLost(away)
        if (r.status === 409) return standDown('다른 탭이나 브라우저가 연동을 넘겨받음')
        // 429: too soon; 410: a newer request of this tab answers (this one was late). Neither is a failure.
        if (r.status === 429 || r.status === 410) pause = 1000
        else {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          const j = await r.json()
          if (run !== downRun) return
          // An answer to another since than the one asked (a proxy that answered a retried request): not ours.
          if (j.since !== since) throw new Error('since')
          errs = 0
          since = j.last
          if (first || j.fresh || serverReady !== true) serverUp(!first && !!j.fresh)
          first = false
          for (const d of j.msgs) {
            if (run !== downRun || stopped) return
            fromServer(JSON.parse(d))
          }
          // News flows: a short breath before the next fetch (the server refuses one sooner than 200 ms).
          if (j.msgs.length) pause = Math.max(pause, 250)
        }
      } catch {
        if (run !== downRun) return
        diag.upFail++
        // A proxy that also cuts a fetch that waits: fetch without waiting, every second.
        if (++errs >= 2 && wait > 0) longOk = false
        if (errs >= 2 && serverReady === true) (serverReady = null), link('server', 'wait', '다시 연결하는 중')
        pause = Math.min(2000 * errs, 30_000)
      }
      if (pause) await sleep(pause)
    }
  }

  /** Whether a stream gets through now: the probe's messages a second apart must arrive apart, not all at the end. */
  function probeStream() {
    return new Promise((resolve) => {
      const at = []
      // The page stream's address, so a proxy that sorts by address treats the probe as it treats streams.
      const p = new EventSource('/api/classic/stream?probe=1')
      const end = (ok) => (p.close(), clearTimeout(t), resolve(ok))
      const t = setTimeout(() => end(false), 7_000)
      p.onmessage = () => {
        at.push(Date.now())
        if (at.length >= 3 && at[at.length - 1] - at[0] >= 1_500) end(true)
      }
      p.onerror = () => end(false)
    })
  }

  function pageStatus() {
    if (!hostId || stopped) return
    queue.push({ t: 'page', visible: document.visibilityState, queue: queue.length, ua: navigator.userAgent.slice(0, 200), openedAt: performance.timeOrigin, path: location.pathname, ...diag })
    pump()
  }
  setInterval(pageStatus, 15_000)
  document.addEventListener('visibilitychange', pageStatus)

  /** When the agent stream last delivered anything. The agent pings every few seconds, so silence means a stalled stream. */
  let agentHeard = 0

  // ---- one tab relays; the others watch it ----
  // The tab that relays holds a lock, and nothing used to check that it was still doing the job: a tab whose
  // relay had broken kept the lock, every other tab waited behind it, and only reloading that one tab helped.
  // Now the relaying tab says every two seconds how it is doing, repairs itself when it can, and a tab that is
  // waiting takes over when the relaying one is broken or silent.
  const SAY_MS = 2000
  /** A relaying tab that has been unwell this long starts its relay over, as a reload would. */
  const REPAIR_MS = 10_000
  /** A waiting tab takes over from a relaying tab that has been unwell this long (its own repair did not help)… */
  const TAKEOVER_MS = 20_000
  /** …or that has said nothing for this long (frozen, or running an older page that does not report). */
  const SILENT_MS = 7_000
  const reachable = (url) => fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(2500) }).then((r) => r.ok, () => false)
  /** Both ends answer, so a relay that is not working is this browser tab's problem and worth replacing. */
  const endsAnswer = async () => (await reachable(`http://127.0.0.1:${agent.port}/ping`)) && (await reachable('/api/health'))
  const healthy = () => !stopped && agentStream?.readyState === EventSource.OPEN && serverReady === true && Date.now() - agentHeard < 15_000
  let badSince = 0
  let lastRepair = 0
  let busyChecking = false
  /** What the relaying tab last said, for a tab that waits: { ok, badSince } and when it was heard. */
  let holder = null
  let holderHeard = 0
  let waitingSince = 0
  let lastTakeover = 0
  let busyTries = 0
  const counts = { takeovers: 0, repairs: 0 }
  /** What this tab's relay is doing, for the page that shows it and for tests. */
  window.__relay = { state: () => ({ holding: !!release, healthy: healthy(), stopped, waiting: !!waitingSince, down: downMode, ...counts, ...said }) }

  /** Start this tab's relay over without giving up its place: what reloading the tab would do. */
  function restart(why) {
    diag.agentReconnects++
    report('warn', 'relay', `연동을 처음부터 다시 시작함: ${why}`)
    agentStream?.close()
    closeDown()
    agentStream = null
    serverReady = false
    conn = null
    hostId = null
    queue.length = 0
    link('server', 'wait', '다시 연결하는 중')
    connectAgent(true)
  }

  function connectAgent(takeover) {
    agentStream?.close()
    // The key this browser has now: another tab may have taken a new one while this tab missed the storage event
    // (frozen or asleep), and would otherwise keep coming with the retired key.
    const now = agentInfo()
    if (now?.key) Object.assign(agent, now)
    // rekey=1: this relay takes a new key over the stream (R1-M8); an older one would pass it on to the server.
    const es = (agentStream = new EventSource(agentUrl(`/events?tab=${TAB}&rekey=1${takeover ? '&takeover=1' : ''}${opts.background ? '&bg=1' : ''}`)))
    es.onopen = () => {
      agentHeard = Date.now()
      link('agent', 'on', '연결됨')
      ui.agentOpen?.()
    }
    es.addEventListener('beat', () => (agentHeard = Date.now()))
    es.onmessage = async (e) => {
      agentHeard = Date.now()
      const msg = JSON.parse(e.data)
      if (msg.t === 'replaced') return standDown('다른 탭이나 브라우저가 연동을 넘겨받음')
      // The agent changed its key: kept for every page of the site in this browser, and never passed on to the server.
      if (msg.t === 'rekey') {
        if (typeof msg.key !== 'string' || !msg.key) return
        agent.key = msg.key
        saveAgentInfo(agent.port, msg.key)
        return report('info', 'relay', '에이전트 키가 바뀌어 새 키로 이어 감')
      }
      if (msg.t === 'busy') {
        // The agent still counts the tab that relayed a moment ago (it was just closed, and the agent has not
        // noticed yet), or a tab in another browser really is relaying. Ask again shortly before believing it:
        // standing down at once left the Mac unconnected for half a minute after a tab was closed.
        es.close()
        if (busyTries++ < 3) return void setTimeout(() => es === agentStream && !stopped && connectAgent(false), 700 * busyTries)
        busyTries = 0
        // The headless browser (헤드리스 연동 모드) holds the link: nothing is wrong and nothing to take over.
        if (msg.headless) return standDown('헤드리스 브라우저가 이 맥을 연동하는 중', false, true)
        return standDown('다른 브라우저의 탭이 이미 이 에이전트와 연동 중', true)
      }
      diag.fromAgent++
      if (msg.t === 'hello') {
        busyTries = 0
        ui.hello?.(msg)
        // A fresh hello restarts the exchange: anything queued before it belongs to the old one.
        queue.length = 0
        if (hostId !== msg.hostId || !conn) {
          hostId = msg.hostId
          const r = await fetch('/api/bridge/hello', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostId, name: msg.name }), redirect: 'manual' })
          const away = turnedAway(r)
          if (away) return loginLost(away)
          const j = await r.json().catch(() => ({}))
          if (!r.ok) return link('server', 'off', j.error || '등록 실패')
          conn = j.conn
          connectServer()
        }
      }
      queue.push(msg)
      pump()
    }
    es.onerror = async () => {
      if (es !== agentStream) return
      // An answer the browser will not retry (a refusal, not a dropped connection): try again ourselves.
      if (es.readyState === EventSource.CLOSED) setTimeout(() => es === agentStream && !stopped && connectAgent(false), 3000)
      // Chrome asks before a public site may reach 127.0.0.1. Until that is allowed, the agent looks unreachable.
      const perm = await navigator.permissions.query({ name: 'local-network-access' }).then((r) => r.state, () => null)
      const safari = /Safari\//.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent)
      link('agent', 'off', perm === 'denied' ? '브라우저가 막음' : '연결 안 됨')
      ui.agentError?.({ perm, safari })
    }
  }

  // Leaving the page (a link, the address bar, back) freezes it in the browser's back/forward cache: its
  // connections stay open for a minute while nothing runs, and the host looks alive but answers nothing.
  // So: say goodbye and close at once, and start over if the page is brought back.
  addEventListener('pagehide', () => {
    if (hostId && conn && !stopped) navigator.sendBeacon('/api/bridge/bye', new Blob([JSON.stringify({ hostId, conn })], { type: 'application/json' }))
    agentStream?.close()
    closeDown()
  })
  addEventListener('pageshow', (e) => e.persisted && location.reload())
  if (opts.confirmLeave)
    addEventListener('beforeunload', (e) => {
      if (!serverReady || stopped) return
      e.preventDefault()
      e.returnValue = ''
    })

  // The server's stream too (it pings every 15 s). The watch's own pauses (a sleeping laptop, a frozen tab) are
  // not the stream's fault: after one, the stream gets a fresh allowance.
  let downTick = Date.now()
  setInterval(() => {
    const now = Date.now()
    const slept = now - downTick > 15_000
    downTick = now
    if (stopped || downMode !== 'sse' || !serverStream || !downFirst) return
    if (slept) serverHeard = now
    else if (now - downLiveAt > 2 * DOWN_STALL_MS) downFails = 0
    if (now - serverHeard > DOWN_STALL_MS) downFailed(`${Math.round((now - serverHeard) / 1000)}초째 서버 스트림이 조용함`)
  }, 5_000)

  // A stream that is open but silent is worse than a closed one: nothing reconnects it. Reopen it ourselves.
  setInterval(() => {
    if (stopped || !agentStream || agentStream.readyState !== EventSource.OPEN) return
    if (Date.now() - agentHeard < 20_000) return
    diag.agentReconnects++
    report('warn', 'relay', `에이전트 스트림이 ${Math.round((Date.now() - agentHeard) / 1000)}초째 조용해 다시 연결함 (탭 ${document.visibilityState})`)
    connectAgent(false)
  }, 5_000)

  /**
   * One relaying tab per agent. Two would take the agent from each other in a loop, each reconnect dropping the
   * host. A tab the agent just opened takes over from an older one; any other tab waits until the active one is
   * closed, and then goes on in its place.
   */
  // Keyed by the agent's port: a second agent on the same Mac gets its own tab.
  const LOCK = `cb-bridge-${agent.port}`
  const tabs = new BroadcastChannel(LOCK)
  let release = null
  function standDown(text, offerTakeover, headless = false) {
    if (stopped) return
    stopped = true
    agentStream?.close()
    closeDown()
    agentStream = null
    serverReady = false
    conn = null
    queue.length = 0
    // The headless browser relaying is how it should be, not a fault: shown as linked, through it.
    link('agent', headless ? 'on' : 'off', text)
    link('server', headless ? 'on' : 'off', headless ? '헤드리스 브라우저로 연결됨 (이 탭은 쉬는 중)' : '이 탭은 멈춤')
    ui.stood?.(text, !!offerTakeover, headless)
    release?.()
    release = null
    waitingSince = 0
    // The control page goes back in line: when the tab that took over is closed, it carries on by itself.
    // Turned away by the agent, it waits a little longer before asking, but not long: while this tab is out of
    // the line, no tab of this browser takes over when the relaying one goes away (that gap used to be 30 s).
    if (opts.persistent) setTimeout(() => run(false), offerTakeover ? 5000 : 1500)
  }
  tabs.onmessage = (e) => {
    const m = e.data
    if (m === 'takeover') return void (release && standDown('다른 탭이 연동을 넘겨받음'))
    if (m?.t === 'who' && release) return say()
    if (m?.t === 'state' && !release && m.tab !== TAB) (holder = m), (holderHeard = Date.now())
  }
  const say = () => tabs.postMessage({ t: 'state', tab: TAB, ok: healthy(), badSince })

  setInterval(async () => {
    if (busyChecking) return
    busyChecking = true
    try {
      if (release) {
        // This tab relays: say how it is going, and start over when it has been unwell for a while.
        badSince = healthy() ? 0 : badSince || Date.now()
        say()
        if (badSince && Date.now() - badSince > REPAIR_MS && Date.now() - lastRepair > REPAIR_MS && (await endsAnswer())) {
          lastRepair = Date.now()
          counts.repairs++
          restart(`${Math.round((Date.now() - badSince) / 1000)}초째 연결되지 않음`)
        }
      } else if (waitingSince && document.visibilityState === 'visible' && Date.now() - lastTakeover > 60_000) {
        // This tab waits, and is the one being looked at (two hidden tabs must not pass the relay back and forth:
        // a hidden tab's timers slow down, and each would find the other silent).
        const silent = Date.now() - (holderHeard || waitingSince) > SILENT_MS
        const broken = holder && !holder.ok && holder.badSince && Date.now() - holder.badSince > TAKEOVER_MS
        if ((silent || broken) && (await endsAnswer()) && !release) {
          lastTakeover = Date.now()
          counts.takeovers++
          log(silent ? '연동하던 탭이 응답하지 않아 이 탭이 넘겨받음' : '연동하던 탭의 연결이 고쳐지지 않아 이 탭이 넘겨받음')
          run(true)
        }
      }
    } finally {
      busyChecking = false
    }
  }, SAY_MS)

  /** This tab's request waiting in line for the lock: asking again must not leave two of them there. */
  let queued = null
  let asked = 0
  let holds = 0
  function run(takeover) {
    queued?.abort()
    queued = takeover ? null : new AbortController()
    const mine = ++asked
    if (!takeover) tabs.postMessage({ t: 'who' })
    waitingSince = Date.now()
    holder = null
    holderHeard = 0
    link('agent', 'wait', '이 사이트의 다른 탭이 연동 중 — 그 탭이 닫히거나 멈추면 이 탭이 이어받습니다')
    link('server', 'wait', '대기')
    navigator.locks
      // A takeover steals the lock: it goes ahead of the tabs already waiting, and the tab that held it loses it.
      .request(LOCK, takeover ? { steal: true } : { signal: queued.signal }, () => new Promise((r) => {
        // Only now, holding the lock, is the tab that relayed told to stop. Told before, it let go of the lock
        // first and the next tab in line got it instead of this one: two tabs then went for the agent at once,
        // one was turned away, and the Mac stayed unconnected when the other was closed.
        if (takeover) tabs.postMessage('takeover')
        if (asked === mine) queued = null
        holds = mine
        release = r
        stopped = false
        waitingSince = 0
        badSince = 0
        lastRepair = Date.now()
        link('server', 'wait', '에이전트를 기다리는 중')
        connectAgent(takeover)
      }))
      // Rejected when another tab stole the lock from this one (or when this tab's wait was called off).
      .catch(() => holds === mine && release && standDown('다른 탭이 연동을 넘겨받음'))
  }
  run(!!opts.takeover)
}
