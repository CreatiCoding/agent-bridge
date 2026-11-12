// End-to-end (AC-1689, AC-1763): a snapshot put together by snapshotPage and drawn by mountSnapshot
// (ui/src/lib/snapshot-page.ts) in a shadow root, as the sheet does since 1.523, under this site's CSP, fetches
// nothing: no @import (quoted, url(), escaped, in a sheet the Mac sent), no url() the Mac did not send (escaped too),
// no image-set()/src() string, no @font-face, no legacy picture attribute, no form that sends. Its inline styles,
// data: pictures and rewritten html/body/:root selectors still apply; this page's styles do not reach in and its
// styles do not reach out; its fixed and stacked elements stay inside its box; a click inside stops there. Since 1.524
// (AC-1764~AC-1767): no @function (escaped, nested) or call of one, no link to this site, a cursor without its
// picture, and an @scope with no start does not reach the host.
// A control (the raw page in a frame) must fetch, or this test proves nothing.
// Needs no bridge server or agent, only Playwright (and Chromium, or CHROME=<path to a Chrome>).
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node test/e2e-snapshot-net.mjs [screenshot.png]
import fs from 'node:fs'
import http from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
const { chromium } = await import(process.env.PLAYWRIGHT)
const ok = (c, w) => (console.log(`${c ? 'PASS' : 'FAIL'} ${w}`), c || (process.exitCode = 1))

const src = fs.readFileSync(new URL('../ui/src/lib/snapshot-page.ts', import.meta.url), 'utf8')
const lib = stripTypeScriptTypes(src).replace(/^export /gm, '') + '\nwindow.snapshotPage = snapshotPage\nwindow.mountSnapshot = mountSnapshot\n'
// The site's own CSP (server/httputil.go), the parts that bear on a snapshot's styles and pictures.
const SITE_CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; base-uri 'self'; object-src 'none'"
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
// The sheet's own rules for the box (ui/src/styles.css), and a style of this page that must not reach in.
const APP_CSS = `
.snapshot-box{position:relative;overflow-x:hidden;overflow-y:auto;width:300px;height:400px;background:#fff}
.snapshot-fit{position:relative;overflow:hidden}
.snapshot-page{position:absolute;top:0;left:0;display:block;transform-origin:0 0;contain:layout paint;isolation:isolate;overflow:hidden;color-scheme:light;background:#fff}
body{font-family:monospace;color:rgb(9, 9, 9)} p{text-decoration:underline}
#outer{position:relative;z-index:1}`

const hits = []
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/capture') {
    hits.push(u.searchParams.get('m'))
    return res.writeHead(200, { 'Content-Type': 'text/css' }).end('')
  }
  if (u.pathname === '/snap.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(lib)
  if (u.pathname === '/') {
    return res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': SITE_CSP })
      .end(`<!doctype html><script src="/snap.js"></script><style>${APP_CSS}</style><body><p id="outer">outside</p><div class="snapshot-box" id="box"><div class="snapshot-fit" id="fit"><div class="snapshot-page" id="wrap"><div class="snapshot-host" id="host"></div></div></div></div></body>`)
  }
  res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const O = `http://127.0.0.1:${server.address().port}`
const cap = (m) => `${O}/capture?m=${m}`
// Another origin for a link that must stay one (a snapshot keeps none to this site's own, 1.524).
const OTHER = O.replace('127.0.0.1', 'localhost')

const html = `<html class="dark" style="--from-html:rgb(11, 12, 13)"><head>
<style>@import "${cap('str')}";</style>
<style>@import url(${cap('url')});</style>
<style>@IMPORT '${cap('upper')}' screen;</style>
<style>@\\69mport "${cap('escaped')}";</style>
<style>/* @import "x"; */ .keep{color:rgb(1, 2, 3)} @import "${cap('late')}";</style>
<link rel="stylesheet" href="${O}/sheet.css">
<link rel="preload" as="image" href="${cap('preload')}">
<link rel="icon" href="${cap('icon')}">
<meta http-equiv="refresh" content="0;url=${cap('refresh')}">
<style>.bg{background-image:url(${cap('bgurl')})} .set{background-image:image-set("${cap('imgset')}" 1x)}
.esc{background-image:\\75 rl(${cap('escurl')})} .src{background-image:src("${cap('srcfn')}")}
@font-face{font-family:x;src:url(${cap('font')})} .font{font-family:x}
@media screen{@supports (display:block){.deep{background:url(${cap('deep')})}}}
:root{--c:rgb(7, 8, 9)} .v{color:var(--c)} html.dark body .d{color:rgb(4, 5, 6)} body{margin:0}
p{color:rgb(1, 2, 3)}
.fixed{position:fixed;top:0;left:0;width:100%;height:100vh;z-index:2147483647;background:rgb(255, 0, 0);opacity:.2}
.var{--u:"${cap('varstr')}";background-image:image-set(var(--u) 1x);width:10px;height:10px}
:host{position:fixed!important;inset:0!important;transform:none!important;contain:none!important;width:auto!important;z-index:2147483647!important}
@function --u(){result:"${cap('fn')}"}
.fn{background:image-set(--u() 1x);cursor:image-set(--u() 1x),auto;list-style-image:image-set(--u() 1x);mask-image:image-set(--u() 1x);border-image-source:image-set(--u() 1x)}
@\\66unction --e(){result:"${cap('fnesc')}"} .fe{background:image-set(--e() 1x)}
@media screen{@supports (display:block){@function --n(){result:"${cap('fnmedia')}"}}} .fm{background:image-set(--n() 1x)}
@scope { :scope { position:fixed!important; inset:0!important; outline:5px solid rgb(255, 0, 0)!important } }
.cur{cursor:url(${PNG}) 1 1, pointer}
@media screen{:is(:host){position:fixed!important;inset:0!important}}
</style>
</head><body background="${cap('bodybg')}" class="page">
<p class="keep" id="keep">snapshot test</p>
<p class="v" id="v">var</p><p class="d" id="d">dark</p>
<div class="bg">a</div><div class="set">b</div><div class="esc">e</div><div class="src">s</div><div class="font">f</div><div class="deep">m</div>
<div style="background:url('${cap('inline')}')">c</div>
<div style="background:u\\rl(${cap('inlineesc')})">c2</div>
<img id="pic" src="${O}/pic.png">
<img src="${cap('img')}" srcset="${cap('srcset')} 2x">
<table background="${cap('tablebg')}"><tr><td>t</td></tr></table>
<svg><image href="${cap('svg')}"/><rect fill="url(${cap('svgfill')})" width="1" height="1"/><a xlink:href="javascript:alert(1)"><text>x</text></a><set attributeName="href" to="javascript:alert(2)"/></svg>
<video poster="${cap('poster')}" src="${cap('video')}"></video>
<form id="f" class="search" action="${cap('form')}" method="get"><input name="q" value="x" id="q"><button id="send" formaction="${cap('formaction')}">send</button></form>
<a id="link" href="${OTHER}/s/abc">another site's link</a> <a id="own" href="${O}/api/x">this site's link</a> <a id="js" href="javascript:alert(3)">js</a>
<ul class="fn"><li>fn</li></ul><div class="fe">fe</div><div class="fm">fm</div><div id="fnattr" style="background-image:image-set(--u() 1x);cursor:image-set(--u() 1x),auto">fa</div>
<div id="cur" class="cur">cur</div><div id="curattr" style="cursor:url(${PNG}) 2 2, move">cur2</div>
<div class="fixed" id="fixed"></div><div class="var">v</div><a id="named" name="x">named</a><img src="${O}/pic.png" attributionsrc="${cap('attrsrc')}">
<div id="plain" onclick="alert(4)">plain</div>
</body></html>`
const css = { [`${O}/sheet.css`]: `@import "${cap('sheet')}"; .sheet{color:red}` }
const images = { [`${O}/pic.png`]: PNG }

const exe = process.env.CHROME
const browser = await chromium.launch(exe ? { executablePath: exe } : {})
const page = await browser.newPage({ viewport: { width: 420, height: 700 } })
await page.goto(`${O}/`)
const out = await page.evaluate((a) => {
  const d = window.snapshotPage(a)
  const host = document.getElementById('host')
  const wrap = document.getElementById('wrap')
  const k = 300 / 412
  wrap.style.width = '412px'
  wrap.style.transform = `scale(${k})`
  wrap.style.setProperty('--cb-vh', `${Math.round(400 / k)}px`)
  const sh = window.mountSnapshot(host, d)
  document.getElementById('fit').style.height = `${Math.ceil(host.offsetHeight * k)}px`
  window.clicks = 0
  window.clickPaths = []
  document.addEventListener('click', (e) => (window.clicks++, window.clickPaths.push(e.composedPath().map((n) => n.id || n.nodeName).join('>'))))
  const text = Array.from(sh.querySelectorAll('style'), (s) => s.textContent).join('\n') + sh.querySelector('cb-html').outerHTML
  return { text, bytes: d.bytes }
}, { url: `${O}/page`, html, images, css })
await page.waitForTimeout(1500)

// A custom property may keep its string (inert: only url(), src() and picture functions fetch, and a picture
// function that takes var() becomes none); no address is left where a style or an element would fetch it.
ok(!/(?:url|src|image-set|image|cross-fade)\([^)]*capture\?m=|(?:src|href|srcset|poster|background|action)="[^"]*capture\?m=/i.test(out.text), 'no address of the page is left where it would be fetched')
ok(/image-set/.test(html) && !/image-set\(var\(/.test(out.text), 'a picture function that takes var() is gone')
ok(hits.length === 0, `the snapshot fetched nothing (${hits.join(', ') || 'none'})`)

const look = await page.evaluate(() => {
  const sh = document.getElementById('host').shadowRoot
  const $ = (s) => sh.querySelector(s)
  const cs = (s) => getComputedStyle($(s))
  const host = document.getElementById('host').getBoundingClientRect()
  const wrap = document.getElementById('wrap').getBoundingClientRect()
  const fixed = $('#fixed').getBoundingClientRect()
  const box = document.getElementById('box').getBoundingClientRect()
  return {
    keep: cs('#keep').color,
    v: cs('#v').color,
    d: cs('#d').color,
    margin: cs('cb-body').marginTop,
    body: $('cb-body').className,
    htmlVar: cs('cb-html').getPropertyValue('--from-html').trim(),
    pic: $('#pic').naturalWidth,
    deco: cs('#keep').textDecorationLine,
    font: cs('#keep').fontFamily,
    outer: getComputedStyle(document.getElementById('outer')).color,
    form: $('form') === null && $('cb-form#f.search') !== null,
    inert: $('#q').inert && $('#send').inert,
    link: [$('#link').getAttribute('target'), $('#link').getAttribute('rel')].join(' '),
    own: $('#own').hasAttribute('href'),
    cursors: [cs('#cur').cursor, cs('#curattr').cursor, cs('#fnattr').cursor, cs('ul.fn').cursor].join(' '),
    pics: ['ul.fn', '.fe', '.fm', '#fnattr'].map((s) => cs(s).backgroundImage + '|' + cs(s).listStyleImage).join(' '),
    hostLook: [getComputedStyle(document.getElementById('host')).position, getComputedStyle(document.getElementById('host')).outlineStyle].join(' '),
    js: $('#js').hasAttribute('href'),
    svgA: sh.querySelector('svg a').hasAttribute('xlink:href'),
    set: sh.querySelector('svg set') === null,
    onclick: $('#plain').hasAttribute('onclick'),
    fixedInside: fixed.top >= wrap.top - 0.5 && fixed.left >= wrap.left - 0.5 && fixed.right <= box.right + 0.5 && Math.abs(host.top - wrap.top) < 0.5,
    hostInside: host.left >= box.left - 0.5 && host.top >= box.top - 0.5 && host.right <= box.right + 0.5,
    host: [host.left, host.top, host.right, host.bottom].map(Math.round).join(','),
    named: $('#named').hasAttribute('href'),
    fixedTop: fixed.top,
    boxTop: box.top,
    over: document.elementFromPoint(box.left + 10, box.bottom + 20)?.id ?? '',
  }
})
ok(look.keep === 'rgb(1, 2, 3)', `its own style still applies (${look.keep})`)
ok(look.v === 'rgb(7, 8, 9)', `:root's custom property reaches its elements (${look.v})`)
ok(look.d === 'rgb(4, 5, 6)', `"html.dark body .d" matches through <cb-html class=dark><cb-body> (${look.d})`)
ok(look.margin === '0px', `"body{margin:0}" applies to <cb-body> (${look.margin})`)
ok(look.body === 'page' && look.htmlVar === 'rgb(11, 12, 13)', `html and body's class and style move to <cb-html>, <cb-body> (${look.body}, ${look.htmlVar})`)
ok(look.pic === 1, `its data: picture still shows (${look.pic})`)
ok(look.deco === 'none' && !/monospace/.test(look.font), `this page's styles do not reach in (${look.deco}, ${look.font})`)
ok(look.outer === 'rgb(9, 9, 9)', `its styles do not reach out (${look.outer})`)
ok(look.form && look.inert, 'its form is a <cb-form> and its controls are inert')
ok(look.link === '_blank noopener noreferrer' && !look.js && !look.svgA && look.set && !look.onclick, 'links open a new tab, no javascript: or handler is left')
ok(look.fixedInside, `a fixed element stays in the snapshot's box (top ${look.fixedTop}, box ${look.boxTop})`)
ok(look.hostInside, `":host{position:fixed!important;inset:0!important…}" does not take the host out of the box (${look.host})`)
ok(!look.named, 'an <a> with no href stays no link')
// 1.524: custom functions, links to this site, cursor pictures and an @scope with no start.
ok(/@function/.test(html) && !/@function|@\\66unction|--[ufen]\(/i.test(out.text), 'no @function and no call of one is left')
ok(look.pics === 'none|none none|none none|none none|none', `a picture named by a custom function is none (${look.pics})`)
ok(!look.own, 'a link to this site has no href')
ok(look.cursors === 'pointer move auto auto', `a cursor is its keyword alone (${look.cursors})`)
ok(look.hostLook === 'static none', `"@scope { :scope {…!important} }" does not reach the host (${look.hostLook})`)
ok(look.over !== 'host' && look.over !== 'wrap', `nothing of it covers this page outside the box (${look.over || 'body'})`)

// A click inside stops at the shadow root; the form sends nothing.
const send = await page.evaluate(() => {
  // Into the box's view first: a point below the box is this page, not the snapshot.
  const b = document.getElementById('host').shadowRoot.querySelector('#send')
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  const box = document.getElementById('box').getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, inside: r.top >= box.top && r.bottom <= box.bottom }
})
ok(send.inside, 'its button is in the box’s view when pressed')
await page.mouse.click(send.x, send.y)
await page.evaluate(() => document.getElementById('host').shadowRoot.querySelector('#plain').click())
await page.waitForTimeout(800)
ok(hits.length === 0, `pressing its button sent nothing (${hits.join(', ') || 'none'})`)
ok((await page.evaluate(() => window.clicks)) === 0, `a click inside does not reach this page (${await page.evaluate(() => window.clickPaths.join(' | ') || 'none')})`)
// Its links still open a new tab, never this page's router.
const popup = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null)
await page.evaluate(() => document.getElementById('host').shadowRoot.querySelector('#link').click())
const tab = await popup
ok(!!tab && page.url() === `${O}/`, `a link opens a new tab and this page stays (${tab ? 'popup' : 'no popup'})`)
await tab?.close()
if (process.argv[2]) await page.screenshot({ path: process.argv[2] })

// A browser without constructable sheets: the selectors stay as written, :host{…!important} included, and the
// wrapper alone keeps the host in its box; nothing is fetched either.
const bare = await page.evaluate((a) => {
  const Real = window.CSSStyleSheet
  window.CSSStyleSheet = function () {
    throw new Error('no constructable sheets')
  }
  let d
  try {
    d = window.snapshotPage(a)
  } finally {
    window.CSSStyleSheet = Real
  }
  document.body.insertAdjacentHTML('beforeend', '<div class="snapshot-box" id="box2"><div class="snapshot-fit" style="height:400px"><div class="snapshot-page" id="wrap2" style="width:412px;transform:scale(0.728)"><div class="snapshot-host" id="host2"></div></div></div></div>')
  const sh = window.mountSnapshot(document.getElementById('host2'), d)
  const box = document.getElementById('box2').getBoundingClientRect()
  const host = document.getElementById('host2').getBoundingClientRect()
  return {
    kept: Array.from(sh.querySelectorAll('style'), (x) => x.textContent).join('\n').includes(':host{position:fixed'),
    // The box scrolls, so the host may run below it; it must not leave it sideways or upwards, nor cover the page.
    inside: host.left >= box.left - 0.5 && host.top >= box.top - 0.5 && host.right <= box.right + 0.5 && document.elementFromPoint(box.left + 5, box.top - 5)?.id !== 'host2',
    host: [host.left, host.top, host.right, host.bottom].map(Math.round).join(','),
    box: [box.left, box.top, box.right, box.bottom].map(Math.round).join(','),
  }
}, { url: `${O}/page`, html, images, css })
await page.waitForTimeout(1000)
ok(bare.kept && bare.inside, `without CSSOM the :host rule stays but the host stays in its box (host ${bare.host}, box ${bare.box})`)
ok(hits.length === 0, `without CSSOM it fetched nothing either (${hits.join(', ') || 'none'})`)

// The control: the raw page in a frame does fetch, so the harness sees a request when there is one.
await page.evaluate(
  (srcdoc) =>
    new Promise((r) => {
      const f = document.createElement('iframe')
      f.onload = () => r()
      f.srcdoc = srcdoc
      document.body.append(f)
    }),
  html,
)
await page.waitForTimeout(1500)
ok(hits.includes('str'), `the raw page fetched (${hits.join(', ')})`)

await browser.close()
server.close()
