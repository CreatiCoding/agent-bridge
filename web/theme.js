// Before the first paint, so a dark device never flashes the light theme. A file of its own: the page's
// Content-Security-Policy does not run inline scripts.
try {
  const t = JSON.parse(localStorage.getItem('theme') || '"auto"')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch {}
