// /skills and /skills/<name>: tick skills on the shelf and the bar writes the install command for them.
// Every action is a command: copy it, or open Claude Code with it filled in — the developer presses Enter.
import { md, esc } from '/markdown.js'

const main = document.getElementById('main')
const bar = document.getElementById('bar')
const toast = document.getElementById('toast')
const CATEGORY = { coding: '개발', etc: 'ETC' }
// Main skills first; etc (things unlike the rest) last, on a tab of their own.
const ORDER = ['coding']
let data = null
let filter = null
const picked = new Set()

// Each repo has its own installer (REQ-F-792), at a signed address the server gives (REQ-S-078); quoted, since zsh
// reads an unquoted ? or & as a pattern or a background job.
const script = () => `curl -fsSL '${data.install}' | bash -s --`
const commands = {
  install: (names) => `${script()} ${names.join(' ')}`,
  reset: (names) => `${script()} --reset ${names.join(' ')}`,
  remove: (name) => `claude plugin uninstall ${name}@${data.market}`,
}
// `!` runs the line as a shell command in Claude Code, so Enter runs it without asking the model.
const deepLink = (cmd) => `claude-cli://open?q=${encodeURIComponent(`! ${cmd}`)}`

function say(text) {
  toast.textContent = text
  toast.classList.add('show')
  clearTimeout(say.t)
  say.t = setTimeout(() => toast.classList.remove('show'), 1800)
}
async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text)
    say(done)
  } catch {
    say('복사하지 못했습니다. 명령을 직접 선택해 복사하세요')
  }
}

const cat = (c) => (c ? `<span class="sk-cat ${esc(c)}">${esc(CATEGORY[c] ?? c)}</span>` : '')
// The upstream security check runs once a day; past this, it has probably stopped.
const CHECK_STALE_MS = 2 * 86_400_000
const ago = (ms) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))}분 전` : ms < 86_400_000 ? `${Math.round(ms / 3600_000)}시간 전` : `${Math.round(ms / 86_400_000)}일 전`)

/** One line on the upstream security check: when it last ran and whether it passed, loud when stopped or failing. */
function checkLine() {
  if (!data.skills.some((s) => s.upstream)) return ''
  const c = data.check
  const since = c ? Date.now() - Date.parse(c.checkedAt) : Infinity
  const run = c?.run ? ` · <a href="${esc(c.run)}" rel="noopener">실행 기록</a>` : ''
  const issues = `<a href="https://github.com/${esc(data.repo)}/issues" rel="noopener">이슈</a>`
  if (!c) return `<p class="sk-check warn" role="status">원본 연결 검사 기록이 없습니다. upstream workflow가 아직 돌지 않았습니다.</p>`
  if (since > CHECK_STALE_MS) return `<p class="sk-check warn" role="status">원본 연결 검사가 ${ago(since)} 이후 돌지 않았습니다. 원본 업데이트가 멈춰 있습니다${run}</p>`
  if (!c.ok) return `<p class="sk-check warn" role="status">마지막 원본 연결 검사(${ago(since)})에서 걸린 변경이 있어 반영하지 않았습니다. ${issues}를 확인하세요${run}</p>`
  return `<p class="sk-check">원본 연결 검사: ${ago(since)} 통과${run}</p>`
}

const stamp = () => `${esc(data.repo)} ${esc(data.sha.slice(0, 7))}${data.date ? `, ${esc(new Date(data.date).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }))} 업데이트` : ''}`

// ----- shelf -----

function renderShelf() {
  document.title = '스킬 · Agent Bridge'
  const cats = [...new Set(data.skills.map((s) => s.category || 'etc'))].sort((a, b) => rank(a) - rank(b))
  if (!data.skills.length) {
    bar.hidden = true
    main.innerHTML = `<div class="sk-head"><h1>스킬</h1><span class="sk-stamp">${stamp()}</span></div><p class="sk-sub">${esc(data.repo)} 저장소에 아직 스킬이 없습니다. 스킬을 push 하면 여기에 나옵니다.</p>`
    return
  }
  if (!cats.includes(filter)) filter = cats[0]
  const count = (c) => data.skills.filter((s) => (s.category || 'etc') === c).length
  const shown = data.skills.filter((s) => (s.category || 'etc') === filter)
  main.innerHTML = `
    <div class="sk-head"><h1>스킬</h1><span class="sk-stamp">${stamp()}</span></div>
    <p class="sk-sub">필요한 스킬을 골라 설치하세요. 스킬마다 따로 설치되고, 저장소에 push하면 다음 실행 때 저절로 업데이트됩니다.</p>
    <p class="sk-access">설치하려면 <a href="https://github.com/${esc(data.repo)}">${esc(data.repo)}</a> 저장소 접근 권한이 있어야 합니다.</p>
    ${checkLine()}
    <div class="sk-tools">
      <div class="sk-tabs" role="group" aria-label="분류">
        ${cats.map((c) => `<button type="button" data-filter="${esc(c)}" aria-pressed="${filter === c}">${esc(CATEGORY[c] ?? c)}<span class="n">${count(c)}</span></button>`).join('')}
      </div>
      <button class="sk-all" type="button" data-all></button>
    </div>
    <ul class="sk-list">
      ${shown
        .map(
          (s) => `
        <li class="sk-row${picked.has(s.name) ? ' on' : ''}" data-row="${esc(s.name)}">
          <input type="checkbox" id="pick-${esc(s.name)}" data-pick="${esc(s.name)}" ${picked.has(s.name) ? 'checked' : ''} aria-describedby="sum-${esc(s.name)}">
          <div class="sk-name"><label for="pick-${esc(s.name)}">${esc(s.name)}</label></div>
          <p class="sk-sum" id="sum-${esc(s.name)}">${esc(s.summary)}</p>
          ${s.keywords.length ? `<div class="sk-kw">${s.keywords.map(esc).join(', ')}</div>` : ''}
          ${s.upstream ? `<div class="sk-kw">원본 연결 · ${esc(s.upstream.repo)}</div>` : ''}
          <div class="sk-side">
            ${cat(s.category)}
            <a class="sk-more" href="/skills/${esc(s.name)}" data-nav>자세히</a>
            <a class="sk-more" href="${esc(deepLink(commands.remove(s.name)))}" data-remove="${esc(s.name)}" aria-label="${esc(s.name)} 삭제">삭제</a>
          </div>
        </li>`,
        )
        .join('')}
    </ul>
    <p class="sk-foot">설치나 삭제를 누르면 Claude Code에 명령이 채워지고, 엔터를 눌러야 실행됩니다. 처음 한 번은 macOS가 터미널 제어를, Claude Code가 폴더 신뢰를 묻습니다.</p>`
  renderBar()
}

const rank = (c) => (ORDER.includes(c) ? ORDER.indexOf(c) : c === 'etc' ? 99 : 50)
const shownNames = () => data.skills.filter((s) => (s.category || 'etc') === filter).map((s) => s.name)
const allPicked = () => shownNames().every((n) => picked.has(n))

function renderBar() {
  const all = document.querySelector('[data-all]')
  // Picks or clears every skill in the tab being looked at.
  if (all) all.textContent = allPicked() ? '모두 해제' : '전체 선택'
  const names = data.skills.map((s) => s.name).filter((n) => picked.has(n))
  // Nothing ticked, nothing to install: the bar stays out of the way.
  bar.hidden = !names.length
  if (!names.length) return
  bar.innerHTML = `
    <div class="sk-bar-in">
      <p class="sk-what">${names.length}개 고름 <button type="button" data-clear>선택 해제</button></p>
      <p class="sk-cmd">${esc(script())} <mark>${names.map(esc).join(' ')}</mark></p>
      <div class="sk-acts">
        <button class="sk-btn" type="button" data-copy="install">명령 복사</button>
        <a class="sk-btn" href="${esc(deepLink(commands.reset(names)))}" data-reset title="설치된 ${esc(data.market)} 스킬을 모두 지우고 고른 것만 설치">초기화하고 설치</a>
        <a class="sk-btn go" href="${esc(deepLink(commands.install(names)))}">Claude Code에서 설치</a>
      </div>
      <p class="sk-help">초기화하고 설치: 설치된 ${esc(data.market)} 스킬을 모두 지우고 고른 것만 설치합니다. 다른 플러그인과 개인 스킬은 그대로입니다.</p>
    </div>`
}

// ----- detail -----

async function renderDetail(name) {
  bar.hidden = true
  const r = await tryFetch(`/api/skills/${encodeURIComponent(name)}`)
  if (!r) return fail(OFFLINE, true)
  if (r.status === 404) return fail('이 이름의 스킬이 없습니다.', true)
  if (!r.ok) return fail((await r.json().catch(() => ({}))).error || '스킬을 불러오지 못했습니다. 새로고침해 보세요.', true)
  const { skill: s } = await r.json()
  document.title = `${s.name} · 스킬 · Agent Bridge`
  main.innerHTML = `
    <article class="sk-detail">
      <a class="sk-back" href="/skills" data-nav>스킬 목록</a>
      <div>${cat(s.category)}</div>
      <h1>${esc(s.name)}</h1>
      <p class="sk-sub">${esc(s.summary)}</p>
      <div class="sk-acts">
        <button class="sk-btn" type="button" data-copy-one="${esc(s.name)}">설치 명령 복사</button>
        <a class="sk-btn go" href="${esc(deepLink(commands.install([s.name])))}">Claude Code에서 설치</a>
        <a class="sk-btn" href="${esc(deepLink(commands.remove(s.name)))}">삭제</a>
      </div>
      <dl class="sk-facts">
        ${
          s.outputStyles?.length
            ? `<dt>켜는 법</dt><dd>출력 스타일이라 설치만으로는 켜지지 않습니다. <code>/config</code> → Output style에서 고르거나 settings에 <code>"outputStyle": "${esc(s.outputStyles[0])}"</code>. 고를 수 있는 이름: ${s.outputStyles.map((n) => `<code>${esc(n)}</code>`).join(', ')}</dd>
        <dt>스타일</dt><dd>${esc(s.description)}</dd>`
            : `<dt>부르는 이름</dt><dd><code>/${esc(s.name)}:${esc(s.name)}</code>${s.argumentHint ? ` <code>${esc(s.argumentHint)}</code>` : ''}</dd>
        <dt>언제 쓰이나</dt><dd>${esc(s.description)}</dd>`
        }
        ${s.allowedTools ? `<dt>허용 도구</dt><dd><code>${esc(s.allowedTools)}</code></dd>` : ''}
        ${s.keywords.length ? `<dt>키워드</dt><dd>${s.keywords.map(esc).join(', ')}</dd>` : ''}
        ${s.license ? `<dt>라이선스</dt><dd>${esc(s.license)}</dd>` : ''}
        ${s.upstream ? `<dt>원본</dt><dd><a href="${esc(s.upstream.url)}" rel="noopener">${esc(s.upstream.repo)}</a> <code>${esc(s.upstream.sha.slice(0, 12))}</code> · 복사본이 아니라 원본 폴더에 연결되어 있습니다. 원본이 바뀌면 보안 검사를 통과한 커밋만 함께 업데이트됩니다.</dd>` : ''}
        <dt>설치 명령</dt><dd><code>${esc(commands.install([s.name]))}</code></dd>
      </dl>
      <div class="sk-doc-head"><h2>${s.outputStyles?.length ? '출력 스타일 본문' : 'SKILL.md'}</h2></div>
      <div class="sk-doc">${md(s.body)}</div>
      <p class="sk-foot">${stamp()}</p>
    </article>`
}

// A failure says what went wrong and offers 다시 시도 (and the way back from a skill's page).
function fail(text, back) {
  bar.hidden = true
  main.innerHTML = `<div class="sk-error" role="alert">${esc(text)}</div><p class="sk-fail-acts"><button type="button" class="sk-btn" data-retry>다시 시도</button>${back ? '<a class="sk-back" href="/skills" data-nav>스킬 목록</a>' : ''}</p>`
}
// fetch that fails as a value: offline (a thrown TypeError) left the page at "불러오는 중…" for ever.
const tryFetch = (url) => fetch(url).catch(() => null)
const OFFLINE = '서버에 닿지 못했습니다. 연결을 확인하고 다시 시도해 주세요.'

async function render() {
  const m = /^\/skills\/([a-z0-9-]+)$/.exec(location.pathname)
  if (m) await renderDetail(m[1])
  else renderShelf()
}

// ----- events -----

document.addEventListener('change', (e) => {
  const box = e.target.closest('[data-pick]')
  if (!box) return
  box.checked ? picked.add(box.dataset.pick) : picked.delete(box.dataset.pick)
  box.closest('.sk-row').classList.toggle('on', box.checked)
  renderBar()
})

document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-row]')
  // A click on the row's empty space ticks it too; links, the box and its label keep their own behaviour.
  if (row && !e.target.closest('a, input, label, button')) {
    const box = row.querySelector('[data-pick]')
    box.checked = !box.checked
    box.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }
  const f = e.target.closest('[data-filter]')
  if (f) return (filter = f.dataset.filter), renderShelf()
  if (e.target.closest('[data-clear]')) return picked.clear(), renderShelf()
  if (e.target.closest('[data-all]')) {
    const on = !allPicked()
    for (const n of shownNames()) on ? picked.add(n) : picked.delete(n)
    return renderShelf()
  }
  if (e.target.closest('[data-copy="install"]')) return copy(commands.install([...picked]), '설치 명령을 복사했습니다')
  const one = e.target.closest('[data-copy-one]')
  if (one) return copy(commands.install([one.dataset.copyOne]), '설치 명령을 복사했습니다')
  const nav = e.target.closest('a[data-nav]')
  if (nav && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
    e.preventDefault()
    history.pushState(null, '', nav.getAttribute('href'))
    render().then(() => window.scrollTo(0, 0))
  }
})
window.addEventListener('popstate', render)

document.addEventListener('click', (e) => e.target.closest?.('[data-retry]') && location.reload())
const r = await tryFetch('/api/skills')
if (!r) fail(OFFLINE)
else if (r.status === 401) location.href = `/api/auth/github?next=${encodeURIComponent(location.pathname)}`
else if (!r.ok) fail((await r.json().catch(() => ({}))).error || '스킬 목록을 불러오지 못했습니다. 새로고침해 보세요.')
else {
  data = await r.json()
  await render()
}
