// The pages in web/ keep the iOS home screen app's status bar painted, not blurred (REQ-F-919, AGENTS.md).
// An iOS 26 home screen app walks up from the element 4px below the top looking for a fixed/sticky box at least 90%
// wide and paints the status bar with the first background on that path; with none it blurs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

// Each page, its theme-color pair (light, dark: the page's own background) and the rule that makes its frame.
const PAGES = [
  { file: 'web/bridge.html', colors: ['#faf9f5', '#262624'], css: 'web/app.css', frame: 'body.bridge { position: fixed; inset: 0; overflow-y: auto; }', root: 'html:has(> body.bridge) { overflow: hidden; }' },
  { file: 'web/start.html', colors: ['#faf9f5', '#262624'], css: 'web/guide.css', frame: 'body.guide { position: fixed; inset: 0; overflow-y: auto;', root: 'html:has(> body.guide) { overflow: hidden; }' },
  { file: 'web/guide-mcp.html', colors: ['#faf9f5', '#262624'], css: 'web/guide.css', frame: 'body.guide { position: fixed; inset: 0; overflow-y: auto;', root: 'html:has(> body.guide) { overflow: hidden; }' },
  { file: 'web/skills.html', colors: ['#f4f5f7', '#17191e'], css: 'web/skills.css', frame: 'body.sk { margin: 0; position: fixed; inset: 0; overflow-y: auto;', root: 'html:has(> body.sk) { overflow: hidden; }' },
  { file: 'web/privacy.html', colors: ['#faf9f5', '#262624'], css: 'web/privacy.html', frame: 'body{margin:0;position:fixed;inset:0;overflow-y:auto;background:var(--bg)', root: 'html{background:var(--bg);overflow:hidden}' },
]

for (const p of PAGES) {
  test(`${p.file}: no viewport-fit=cover, theme-color for light and dark, a fixed painted frame`, () => {
    const html = read(p.file)
    assert.doesNotMatch(html, /viewport-fit=cover/, 'viewport-fit=cover 를 쓰지 않음')
    assert.match(html, /<meta name="color-scheme" content="light dark"/)
    assert.match(html, new RegExp(`<meta name="theme-color" content="${p.colors[0]}" media="\\(prefers-color-scheme: light\\)"`))
    assert.match(html, new RegExp(`<meta name="theme-color" content="${p.colors[1]}" media="\\(prefers-color-scheme: dark\\)"`))
    const css = read(p.css)
    assert.ok(css.includes(p.frame), `${p.css}: 틀이 fixed, 안에서 스크롤`)
    assert.ok(css.includes(p.root), `${p.css}: 뿌리는 스크롤하지 않음(그래야 body 가 스크롤된다)`)
  })
}

test('the sign-in pages drawn by the server (login.css) have the same frame', () => {
  const css = read('web/login.css')
  assert.ok(css.includes('html:has(> body.bridge-login) { overflow: hidden; }'))
  assert.match(css, /\.bridge-login \{ position: fixed; inset: 0; overflow-y: auto;[^}]*background: var\(--bg\)/)
})

test('a theme picked in the app also sets theme-color (web/theme.js)', () => {
  const js = read('web/theme.js')
  assert.match(js, /meta\[name="theme-color"\]/)
  assert.match(js, /addEventListener\('load'/)
})
