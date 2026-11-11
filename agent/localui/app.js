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
  var convTimer = 0
  // What the pane shows: the conversation as messages (from the transcript) or the terminal as it looks.
  var TAB_KEY = 'cb-local-tab'
  var tab = (function () { try { return localStorage.getItem(TAB_KEY) === 'term' ? 'term' : 'conv' } catch (e) { return 'conv' } })()
  var picked = []
  var FILES_MAX = 4
  var FILE_MAX = 8 * 1024 * 1024

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
    clearInterval(convTimer)
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
    // The folders of this Mac's sessions, offered for a new one.
    var dl = $('cwds')
    var seen = {}
    var opts = document.createDocumentFragment()
    s.sessions.forEach(function (x) {
      if (!x.cwd || seen[x.cwd]) return
      seen[x.cwd] = true
      var o = document.createElement('option')
      o.value = x.cwd
      opts.appendChild(o)
    })
    dl.replaceChildren(opts)
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
    var changed = id !== current
    current = id
    $('newpane').hidden = true
    $('empty').hidden = !!id
    $('pane').hidden = !id
    $('card').removeAttribute('data-id')
    if (changed) {
      $('conv').replaceChildren()
      $('conv').removeAttribute('data-key')
      $('screen').removeAttribute('data-sid')
      $('msg').textContent = ''
      armClose(false)
    }
    if (lastState) renderState(lastState)
    if (id) load()
  }
  function showTab(t) {
    tab = t
    try { localStorage.setItem(TAB_KEY, t) } catch (e) {}
    document.querySelectorAll('[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === t ? 'true' : 'false') })
    $('conv').hidden = t !== 'conv'
    $('screen').hidden = t !== 'term'
    load()
  }
  function load() {
    if (tab === 'conv') loadConv()
    else loadScreen()
  }
  // ---------- the conversation as messages ----------
  // Markdown drawn the way the web page draws it (ui/src/lib/markdown.tsx), from the same blocks. Every piece
  // of a message goes in as text: no message is ever read as HTML.
  function node(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }
  function mdInline(parts, into) {
    parts.forEach(function (p) {
      if (p.t === 'text') return into.appendChild(document.createTextNode(p.text))
      if (p.t === 'code') return into.appendChild(node('code', '', p.text))
      if (p.t === 'link') {
        var a = node('a', '', p.text)
        a.href = p.href
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        return into.appendChild(a)
      }
      var w = node(p.t === 'strong' ? 'strong' : p.t === 'del' ? 'del' : 'em')
      mdInline(p.kids, w)
      into.appendChild(w)
    })
    return into
  }
  function mdLines(text, into) {
    text.split('\n').forEach(function (l, i) {
      if (i) into.appendChild(document.createElement('br'))
      mdInline(window.CbMd.inlineParts(l), into)
    })
    return into
  }
  function mdCode(b) {
    var box = node('div', 'codebox')
    if (b.lang) box.appendChild(node('span', 'codebox-lang', b.lang))
    var copy = node('button', 'codebox-copy', '복사')
    copy.type = 'button'
    copy.addEventListener('click', function () {
      if (!navigator.clipboard) return
      navigator.clipboard.writeText(b.code).then(function () {
        copy.textContent = '복사됨'
        setTimeout(function () { copy.textContent = '복사' }, 1200)
      }, function () {})
    })
    box.appendChild(copy)
    var code = node('code')
    if (window.CbMd.isDiff(b.code, b.lang)) {
      b.code.split('\n').forEach(function (l) { code.appendChild(node('span', window.CbMd.diffLine(l) || '', l + '\n')) })
    } else code.textContent = b.code
    var pre = node('pre')
    pre.appendChild(code)
    box.appendChild(pre)
    return box
  }
  function mdBlocks(text) {
    var root = node('div', 'md')
    window.CbMd.parse(text).forEach(function (b) {
      if (b.t === 'p') return root.appendChild(mdLines(b.text, node('p')))
      if (b.t === 'h') return root.appendChild(mdInline(window.CbMd.inlineParts(b.text), node('h' + Math.min(6, b.level + 1))))
      if (b.t === 'code') return root.appendChild(mdCode(b))
      if (b.t === 'quote') {
        var q = node('blockquote')
        q.appendChild(mdBlocks(b.text))
        return root.appendChild(q)
      }
      if (b.t === 'hr') return root.appendChild(node('hr'))
      if (b.t === 'table') {
        var wrap = node('div', 'md-table')
        var table = node('table')
        var tr = node('tr')
        b.head.forEach(function (c, j) {
          var th = mdInline(window.CbMd.inlineParts(c), node('th'))
          if (b.align[j]) th.style.textAlign = b.align[j]
          tr.appendChild(th)
        })
        var thead = node('thead')
        thead.appendChild(tr)
        table.appendChild(thead)
        var tbody = node('tbody')
        b.rows.forEach(function (r) {
          var row = node('tr')
          b.head.forEach(function (_, j) {
            var td = mdInline(window.CbMd.inlineParts(r[j] || ''), node('td'))
            if (b.align[j]) td.style.textAlign = b.align[j]
            row.appendChild(td)
          })
          tbody.appendChild(row)
        })
        table.appendChild(tbody)
        wrap.appendChild(table)
        return root.appendChild(wrap)
      }
      if (b.t === 'list') {
        var list = node(b.ordered ? 'ol' : 'ul')
        if (b.ordered && b.start !== 1) list.start = b.start
        b.items.forEach(function (it) {
          var li = node('li', it.check !== undefined ? 'task' : '')
          if (it.depth) li.style.marginLeft = it.depth * 1.2 + 'em'
          if (it.check !== undefined) {
            var box = node('span', 'task-box' + (it.check ? ' on' : ''))
            box.setAttribute('aria-hidden', 'true')
            li.appendChild(box)
          }
          list.appendChild(mdLines(it.text, li))
        })
        root.appendChild(list)
      }
    })
    return root
  }
  function stamp(at) {
    var d = at ? new Date(at) : null
    if (!d || isNaN(d)) return ''
    var p = function (n) { return (n < 10 ? '0' : '') + n }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  function loadConv() {
    if (!current || document.hidden || tab !== 'conv') return
    var sid = current
    api('GET', 'conv?sid=' + encodeURIComponent(sid)).then(function (r) {
      if (sid !== current) return
      var el = $('conv')
      var list = r.messages || []
      // Drawn again only when something changed: the place being read stays put.
      var key = sid + ':' + r.total + ':' + list.length + ':' + (list.length ? list[list.length - 1].text.length : 0)
      if (el.getAttribute('data-key') === key) return
      var first = el.getAttribute('data-key') === null
      var bottom = first || el.scrollHeight - el.scrollTop - el.clientHeight < 60
      var frag = document.createDocumentFragment()
      if (r.before) {
        var more = document.createElement('p')
        more.className = 'muted more'
        more.textContent = '앞의 대화 ' + r.before + '개' + (r.partial ? ' 이상' : '') + '는 맥 터미널이나 웹 화면에서 보세요.'
        frag.appendChild(more)
      }
      if (!list.length) {
        var none = document.createElement('p')
        none.className = 'muted more'
        none.textContent = '아직 대화가 없어요.'
        frag.appendChild(none)
      }
      list.forEach(function (m) {
        var b = document.createElement('div')
        b.className = 'bubble ' + (m.me ? 'me' : 'ai')
        // Claude's answers are Markdown read by the web page's own parser (md.js); what I sent stays as typed.
        var t = !m.me && window.CbMd ? mdBlocks(m.text) : document.createElement('div')
        t.className = t.className ? t.className + ' btext' : 'btext'
        if (m.me || !window.CbMd) t.textContent = m.text
        var w = document.createElement('div')
        w.className = 'when'
        w.textContent = (m.me ? '나' : 'Claude') + (stamp(m.at) ? ' · ' + stamp(m.at) : '')
        b.appendChild(t)
        b.appendChild(w)
        frag.appendChild(b)
      })
      el.replaceChildren(frag)
      el.setAttribute('data-key', key)
      if (bottom) el.scrollTop = el.scrollHeight
    }, function (e) { if (e.message !== '401') say(e) })
  }
  function say(e) { $('msg').textContent = e && e.message !== '401' ? '⚠️ ' + e.message : '' }
  function loadScreen() {
    if (!current || document.hidden || tab !== 'term') return
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

  // ---------- files ----------
  function renderChips() {
    var box = $('chips')
    var frag = document.createDocumentFragment()
    picked.forEach(function (f, i) {
      var c = document.createElement('button')
      c.type = 'button'
      c.className = 'chip'
      c.title = '빼기'
      c.textContent = (/^image\//.test(f.type) ? '🖼 ' : '📄 ') + f.name + ' ✕'
      c.addEventListener('click', function () { picked.splice(i, 1); renderChips() })
      frag.appendChild(c)
    })
    box.replaceChildren(frag)
    box.hidden = !picked.length
  }
  function addFiles(list) {
    for (var i = 0; i < list.length; i++) {
      var f = list[i]
      if (picked.length >= FILES_MAX) { $('msg').textContent = '⚠️ 파일은 한 번에 ' + FILES_MAX + '개까지예요.'; break }
      if (f.size > FILE_MAX) { $('msg').textContent = '⚠️ 파일 하나는 8 MB 까지예요: ' + f.name; continue }
      if (!f.size) { $('msg').textContent = '⚠️ 빈 파일이에요: ' + f.name; continue }
      picked.push(f)
    }
    renderChips()
  }
  function readB64(f) {
    return new Promise(function (ok, bad) {
      var r = new FileReader()
      r.onload = function () { ok(String(r.result).replace(/^data:[^,]*,/, '')) }
      r.onerror = function () { bad(new Error('파일을 읽지 못했어요: ' + f.name)) }
      r.readAsDataURL(f)
    })
  }
  $('attach').addEventListener('click', function () { $('files').click() })
  $('files').addEventListener('change', function () { addFiles($('files').files); $('files').value = '' })
  // A picture pasted into the box goes with the message too.
  $('text').addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.files
    if (items && items.length) { e.preventDefault(); addFiles(items) }
  })

  // ---------- actions ----------
  var sending = false
  $('send').addEventListener('submit', function (e) {
    e.preventDefault()
    var t = $('text').value
    if (!current || sending || (!t.trim() && !picked.length)) return
    var sid = current
    var files = picked.slice()
    sending = true
    $('msg').textContent = files.length ? '파일을 보내는 중…' : ''
    Promise.all(files.map(function (f) { return readB64(f).then(function (d) { return { name: f.name, data: d } }) })).then(function (list) {
      return api('POST', 'send', list.length ? { sid: sid, text: t, files: list } : { sid: sid, text: t })
    }).then(function () {
      $('text').value = ''
      picked = []
      renderChips()
      $('msg').textContent = '보냈어요.'
      setTimeout(load, 400)
    }, say).then(function () { sending = false })
  })
  document.querySelectorAll('[data-tab]').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')) })
  })
  // Closing asks twice in place (no dialog): the first press arms it for a few seconds.
  var closeTimer = 0
  function armClose(on) {
    clearTimeout(closeTimer)
    var b = $('close')
    b.classList.toggle('danger', on)
    b.textContent = on ? '정말 닫기' : '닫기'
    if (on) closeTimer = setTimeout(function () { armClose(false) }, 4000)
  }
  $('close').addEventListener('click', function () {
    if (!current) return
    if (!$('close').classList.contains('danger')) return armClose(true)
    armClose(false)
    var sid = current
    api('POST', 'close', { sid: sid }).then(function () {
      if (sid === current) pick('')
      refresh()
    }, say)
  })
  // ---------- a new session ----------
  $('new').addEventListener('click', function () {
    current = ''
    $('pane').hidden = true
    $('empty').hidden = true
    $('newpane').hidden = false
    $('new-msg').textContent = ''
    if (lastState) renderState(lastState)
    $('new-cwd').focus()
  })
  $('new-cancel').addEventListener('click', function () {
    $('newpane').hidden = true
    $('empty').hidden = false
  })
  var starting = false
  $('newpane').addEventListener('submit', function (e) {
    e.preventDefault()
    var cwd = $('new-cwd').value.trim()
    if (!cwd || starting) return
    starting = true
    $('new-msg').textContent = '세션을 띄우는 중…'
    api('POST', 'new', { cwd: cwd, prompt: $('new-prompt').value }).then(function (r) {
      $('new-prompt').value = ''
      $('new-msg').textContent = ''
      return refresh().then(function () { pick(r.sid) })
    }, function (err) { $('new-msg').textContent = '⚠️ ' + (err.message === '401' ? '' : err.message) }).then(function () { starting = false })
  })
  $('text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('send').requestSubmit()
  })
  document.querySelectorAll('[data-key]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (current) api('POST', 'key', { sid: current, keys: [b.getAttribute('data-key')] }).then(function () { setTimeout(load, 250) }, say)
    })
  })
  document.querySelector('[data-esc]').addEventListener('click', function () {
    if (current) api('POST', 'esc', { sid: current }).then(function () { setTimeout(load, 400) }, say)
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
    clearInterval(convTimer)
    stateTimer = setInterval(refresh, 3000)
    screenTimer = setInterval(loadScreen, 1200)
    convTimer = setInterval(loadConv, 2000)
    showTab(tab)
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
