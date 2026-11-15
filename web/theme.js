// Before the first paint, so a dark device never flashes the light theme. A file of its own: the page's
// Content-Security-Policy does not run inline scripts.
try {
  const t = JSON.parse(localStorage.getItem('theme') || '"auto"')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch {}
// A theme picked in the app (data-theme) also sets the status bar colour (theme-color), not only the device's: the
// page's own background, read once its CSS is in.
if (document.documentElement.dataset.theme) addEventListener('load', () => {
  const bg = getComputedStyle(document.body).backgroundColor
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', bg)
})
