// End-to-end (AC-1689): a snapshot put together by snapshotPage (ui/src/lib/snapshot-page.ts), shown in the same
// sandboxed frame as the sheet's and under this site's CSP, fetches nothing: no @import (quoted, url(), escaped, in
// a sheet the Mac sent), no url() the Mac did not send, no legacy picture attribute. Its inline styles and data:
// pictures still show. A control frame with the raw page must fetch, or this test proves nothing.
// Needs no bridge server or agent, only Playwright (and Chromium, or CHROME=<path to a Chrome>).
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node test/e2e-snapshot-net.mjs
import fs from 'node:fs'
import http from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
const { chromium } = await import(process.env.PLAYWRIGHT)
const ok = (c, w) => (console.log(`${c ? 'PASS' : 'FAIL'} ${w}`), c || (process.exitCode = 1))

const src = fs.readFileSync(new URL('../ui/src/lib/snapshot-page.ts', import.meta.url), 'utf8')
const lib = stripTypeScriptTypes(src).replace(/^export /gm, '') + '\nwindow.snapshotPage = snapshotPage\n'
// The site's own CSP (server/httputil.go), the parts that bear on a frame's styles and pictures.
const SITE_CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; base-uri 'self'; object-src 'none'"
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const hits = []
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/capture') {
    hits.push(u.searchParams.get('m'))
    return res.writeHead(200, { 'Content-Type': 'text/css' }).end('')
  }
  if (u.pathname === '/snap.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(lib)
  if (u.pathname === '/') {
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': SITE_CSP }).end('<!doctype html><script src="/snap.js"></script><body></body>')
  }
  res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const O = `http://127.0.0.1:${server.address().port}`
const cap = (m) => `${O}/capture?m=${m}`

const html = `<html><head>
<style>@import "${cap('str')}";</style>
<style>@import url(${cap('url')});</style>
<style>@IMPORT '${cap('upper')}' screen;</style>
<style>@\\69mport "${cap('escaped')}";</style>
<style>/* @import "x"; */ .keep{color:rgb(1, 2, 3)} @import "${cap('late')}";</style>
<link rel="stylesheet" href="${O}/sheet.css">
<style>.bg{background-image:url(${cap('bgurl')})} .set{background-image:image-set("${cap('imgset')}" 1x)}</style>
</head><body background="${cap('bodybg')}">
<p class="keep" id="keep">snapshot test</p>
<div class="bg">a</div><div class="set">b</div>
<div style="background:url('${cap('inline')}')">c</div>
<img id="pic" src="${O}/pic.png">
<table background="${cap('tablebg')}"><tr><td>t</td></tr></table>
<svg><image href="${cap('svg')}"/></svg>
</body></html>`
const css = { [`${O}/sheet.css`]: `@import "${cap('sheet')}"; .sheet{color:red}` }
const images = { [`${O}/pic.png`]: PNG }

const exe = process.env.CHROME
const browser = await chromium.launch(exe ? { executablePath: exe } : {})
const page = await browser.newPage()
await page.goto(`${O}/`)
const doc = await page.evaluate((a) => window.snapshotPage(a), { url: `${O}/page`, html, images, css })
ok(!['str', 'url', 'upper', 'escaped', 'late', 'sheet'].some((m) => doc.includes(cap(m))), 'no @import is left in the document')
ok(/<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';/.test(doc), 'its own CSP comes first in <head>')

const frame = async (name, srcdoc) => {
  await page.evaluate(
    ([name, srcdoc]) =>
      new Promise((r) => {
        const f = document.createElement('iframe')
        f.name = name
        f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
        f.referrerPolicy = 'no-referrer'
        f.onload = () => r()
        f.srcdoc = srcdoc
        document.body.append(f)
      }),
    [name, srcdoc],
  )
}
await frame('snap', doc)
await page.waitForTimeout(1500)
ok(hits.length === 0, `the snapshot fetched nothing (${hits.join(', ') || 'none'})`)

const f = page.frame({ name: 'snap' })
const look = await f.evaluate(() => ({
  color: getComputedStyle(document.getElementById('keep')).color,
  pic: document.getElementById('pic').naturalWidth,
}))
ok(look.color === 'rgb(1, 2, 3)', `its inline style still applies (${look.color})`)
ok(look.pic === 1, `its data: picture still shows (${look.pic})`)

// The control: the raw page in the same frame does fetch, so the harness sees a request when there is one.
await frame('raw', html)
await page.waitForTimeout(1500)
ok(hits.includes('str'), `the raw page in the same frame fetched (${hits.join(', ')})`)

await browser.close()
server.close()
