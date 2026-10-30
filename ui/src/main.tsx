import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { get } from './lib/api'
import { applyIcons, getIcons } from './lib/local'
import { fromHash, interceptLinks } from './lib/router'
import { connect } from './lib/store'
import type { Me } from './lib/types'
import { startBackgroundRelay } from './components/relay-status'
import { setFeatures } from './lib/features'
import './styles.css'

// The meta theme colour follows the page's own theme, so the phone's status bar matches it.
function themeColour() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', bg)
}
addEventListener('cb-theme', themeColour)
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeColour)

// An address of before (/#/s/<id>) becomes its path before anything is drawn; links to the page's own addresses
// move without reloading.
fromHash()
interceptLinks()

connect()
navigator.serviceWorker?.register('/sw.js', { scope: '/' }).catch(() => {})

const root = createRoot(document.getElementById('root')!)
const render = (me: Me | null) =>
  root.render(
    <StrictMode>
      <App me={me} />
    </StrictMode>,
  )
applyIcons(getIcons())
render(null)
// The demo account (REQ-F-766) never links the Mac it is opened on: it has only the server's demo Mac. Nor does a
// page at another origin of the server (origins.extra, REQ-F-815): the agent takes the primary origin only.
get<Me>('/api/me').then(
  (me) => {
    if (me.icons) applyIcons(me.icons)
    setFeatures(me.features)
    if (!me.demo && me.linkHere !== false) startBackgroundRelay()
    render(me)
  },
  () => startBackgroundRelay(),
)
requestAnimationFrame(themeColour)
