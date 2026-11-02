// The local screen's page (docs/LOCAL-UI-DESIGN.md). Served by this Mac's agent from a bundle signed with the
// maintainer's key; it talks to the agent at the same address only. The sign-in token lives in this origin's
// localStorage (http://127.0.0.1:<port>, the port included), never in a cookie.
'use strict'
;(function () {
  var TOKEN_KEY = 'cb-local-token'
  var $ = function (id) { return document.getElementById(id) }
  var store = {
    get: function () { try { return localStorage.getItem(TOKEN_KEY) || '' } catch (e) { return '' } },
    set: function (v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY) } catch (e) {} },
  }
  var token = store.get()
  var current = ''
  var lastState = null
  var screenTimer = 0
  var stateTimer = 0

  function api(method, path, body) {
    var headers = { 'X-Local-UI': '1' }
    if (token) headers.Authorization = 'Bearer ' + token
    if (body) headers['Content-Type'] = 'application/json'
    return fetch('api/' + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit' }).then(function (r) {
      if (r.status === 401) {
        signedOut('로그인이 끝났어요. 맥 터미널에서 새 링크를 받아 주세요.')
        throw new Error('401')
      }
      return r.json().catch(function () { return {} }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status))
        return j
      })
    })
  }

  function signedOut(why) {
    token = ''
    store.set('')
    clearInterval(screenTimer)
    clearInterval(stateTimer)
    $('app').hidden = true
    $('logout').hidden = true
    $('login').hidden = false
    $('login-msg').textContent = why || ''
  }

  // ---------- the terminal's colours (SGR) ----------
  var BASE = ['#1d1d1b', '#d4553d', '#5aa96b', '#c9a227', '#4f86c6', '#a56cc1', '#3fa7a7', '#d6d6d0', '#6b6b66', '#f0735a', '#7fd08f', '#e8c547', '#79a8e0', '#c897df', '#68cfcf', '#ffffff']
  function color256(n) {
    if (n < 16) return BASE[n]
    if (n < 232) {
      n -= 16
      var c = [0, 95, 135, 175, 215, 255]
      return 'rgb(' + c[Math.floor(n / 36)] + ',' + c[Math.floor(n / 6) % 6] + ',' + c[n % 6] + ')'
    }
    var g = 8 + (n - 232) * 10
    return 'rgb(' + g + ',' + g + ',' + g + ')'
  }
  function drawAnsi(el, text) {
    var frag = document.createDocumentFragment()
    var st = {}
    var re = /\x1b\[([0-9;]*)m/g
    var at = 0
    var m
    function put(s) {
      if (!s) return
      var span = document.createElement('span')
      span.textContent = s
      if (st.fg) span.style.color = st.fg
      if (st.bg) span.style.backgroundColor = st.bg
      if (st.bold) span.style.fontWeight = '700'
      if (st.dim) span.style.opacity = '0.65'
      if (st.italic) span.style.fontStyle = 'italic'
      if (st.under) span.style.textDecoration = 'underline'
      if (st.inv) { span.style.color = st.bg || 'var(--term-bg)'; span.style.backgroundColor = st.fg || 'var(--term-fg)' }
      frag.appendChild(span)
    }
    while ((m = re.exec(text))) {
      put(text.slice(at, m.index))
      at = re.lastIndex
      var p = m[1] === '' ? [0] : m[1].split(';').map(Number)
      for (var i = 0; i < p.length; i++) {
        var c = p[i]
        if (c === 0) st = {}
        else if (c === 1) st.bold = true
        else if (c === 2) st.dim = true
        else if (c === 3) st.italic = true
        else if (c === 4) st.under = true
        else if (c === 7) st.inv = true
        else if (c === 22) { st.bold = false; st.dim = false }
        else if (c === 23) st.italic = false
        else if (c === 24) st.under = false
        else if (c === 27) st.inv = false
        else if (c >= 30 && c <= 37) st.fg = BASE[c - 30]
        else if (c === 39) st.fg = null
        else if (c >= 40 && c <= 47) st.bg = BASE[c - 40]
        else if (c === 49) st.bg = null
        else if (c >= 90 && c <= 97) st.fg = BASE[c - 82]
        else if (c >= 100 && c <= 107) st.bg = BASE[c - 92]
        else if ((c === 38 || c === 48) && p[i + 1] === 5) { st[c === 38 ? 'fg' : 'bg'] = color256(p[i + 2] | 0); i += 2 }
        else if ((c === 38 || c === 48) && p[i + 1] === 2) { st[c === 38 ? 'fg' : 'bg'] = 'rgb(' + (p[i + 2] | 0) + ',' + (p[i + 3] | 0) + ',' + (p[i + 4] | 0) + ')'; i += 4 }
      }
    }
    put(text.slice(at).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
    el.replaceChildren(frag)
  }

  // ---------- sessions ----------
  var PHASE = { idle: '쉬는 중', busy: '일하는 중', waiting: '응답 대기', starting: '뜨는 중', ended: '멈춤' }
  function renderState(s) {
    lastState = s
    $('host').textContent = (s.name || '이 맥') + ' · 로컬 화면'
    $('link').textContent = s.linked ? '서버와 연동 중' : '서버 연동 끊김'
    $('foot').textContent = '화면 묶음 ' + (s.bundle ? (s.bundle.source === 'remote' ? '원격 ' : '기본 ') + s.bundle.version : '?') + (s.trust && s.trust !== 'off' ? ' · trust ' + s.trust : '') + ' · 127.0.0.1 전용'
    var nav = $('sessions')
    var frag = document.createDocumentFragment()
    s.sessions.forEach(function (x) {
      var b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('aria-current', x.id === current ? 'true' : 'false')
      var name = document.createElement('span')
      name.textContent = (x.alive ? (x.card ? '🟠 ' : x.busy ? '🟢 ' : '⚪ ') : '⚫ ') + (x.name || x.id.slice(0, 8))
      var sub = document.createElement('span')
      sub.className = 'sub'
      sub.textContent = x.cwd + (x.held ? ' · 붙잡힌 글 ' + x.held : '')
      b.appendChild(name)
      b.appendChild(sub)
      b.addEventListener('click', function () { pick(x.id) })
      frag.appendChild(b)
    })
    if (!s.sessions.length) {
      var p = document.createElement('p')
      p.className = 'muted'
      p.textContent = '이 맥에 세션이 없어요.'
      frag.appendChild(p)
    }
    nav.replaceChildren(frag)
    var me = s.sessions.find(function (x) { return x.id === current })
    if (current && !me) pick('')
    if (me) renderSession(me)
  }
  function renderSession(x) {
    $('title').textContent = x.name || x.id
    $('phase').textContent = x.alive ? PHASE[x.phase] || x.phase || '' : '멈춤'
    var card = $('card')
    if (!x.card) {
      card.hidden = true
      card.replaceChildren()
      return
    }
    if (card.getAttribute('data-id') === x.card.id) return
    card.setAttribute('data-id', x.card.id)
    var h = document.createElement('div')
    h.textContent = x.card.title || '세션이 묻고 있어요'
    var opts = document.createElement('div')
    opts.className = 'opts'
    ;(x.card.options || []).forEach(function (o) {
      var b = document.createElement('button')
      b.type = 'button'
      b.textContent = o.n + '. ' + o.label
      b.addEventListener('click', function () {
        api('POST', 'answer', { sid: current, card: x.card.id, n: o.n }).then(refresh, say)
      })
      opts.appendChild(b)
    })
    card.replaceChildren(h, opts)
    card.hidden = false
  }
  function pick(id) {
    current = id
    $('empty').hidden = !!id
    $('pane').hidden = !id
    $('card').removeAttribute('data-id')
    if (lastState) renderState(lastState)
    if (id) loadScreen()
  }
  function say(e) { $('msg').textContent = e && e.message !== '401' ? '⚠️ ' + e.message : '' }
  function loadScreen() {
    if (!current || document.hidden) return
    var sid = current
    api('GET', 'screen?sid=' + encodeURIComponent(sid)).then(function (r) {
      if (sid !== current) return
      var el = $('screen')
      var first = el.getAttribute('data-sid') !== sid
      var bottom = first || el.scrollHeight - el.scrollTop - el.clientHeight < 40
      // A tall terminal draws Claude at its foot: the empty lines above it are left out.
      // and runs of them in the middle fold to one, so what was said stays in view.
      drawAnsi(el, (r.text || '').replace(/^(?:[ \t]*(?:\x1b\[[0-9;]*m)*[ \t]*\n)+/, '').replace(/\n(?:[ \t]*(?:\x1b\[[0-9;]*m)*[ \t]*\n){2,}/g, '\n\n'))
      el.setAttribute('data-sid', sid)
      if (bottom) el.scrollTop = el.scrollHeight
    }, function () {})
  }
  function refresh() {
    return api('GET', 'state').then(renderState, say)
  }

  // ---------- actions ----------
  $('send').addEventListener('submit', function (e) {
    e.preventDefault()
    var t = $('text').value
    if (!current || !t.trim()) return
    api('POST', 'send', { sid: current, text: t }).then(function () {
      $('text').value = ''
      $('msg').textContent = '보냈어요.'
      setTimeout(loadScreen, 400)
    }, say)
  })
  $('text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('send').requestSubmit()
  })
  document.querySelectorAll('[data-key]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (current) api('POST', 'key', { sid: current, keys: [b.getAttribute('data-key')] }).then(function () { setTimeout(loadScreen, 250) }, say)
    })
  })
  document.querySelector('[data-esc]').addEventListener('click', function () {
    if (current) api('POST', 'esc', { sid: current }).then(function () { setTimeout(loadScreen, 400) }, say)
  })
  $('logout').addEventListener('click', function () {
    api('POST', 'logout', {}).catch(function () {}).then(function () { signedOut('나갔어요.') })
  })

  function start() {
    $('login').hidden = true
    $('app').hidden = false
    $('logout').hidden = false
    refresh()
    clearInterval(stateTimer)
    clearInterval(screenTimer)
    stateTimer = setInterval(refresh, 3000)
    screenTimer = setInterval(loadScreen, 1200)
  }

  // The ticket is after '#': it never went over HTTP. It is taken off the address at once.
  var m = /[#&]t=([A-Za-z0-9_-]{43})/.exec(location.hash)
  if (m) history.replaceState(null, '', location.pathname)
  // This page came up: an agent that just put this bundle in place keeps it (no rollback).
  fetch('api/booted', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-UI': '1' }, body: '{}', credentials: 'omit' }).catch(function () {})
  if (m) {
    api('POST', 'login', { ticket: m[1] }).then(function (r) {
      token = r.token
      store.set(token)
      start()
    }, function (e) { signedOut('링크가 맞지 않거나 시간이 지났어요(' + e.message + '). 맥 터미널에서 새 링크를 받아 주세요.') })
  } else if (token) start()
  else signedOut('')
})()
