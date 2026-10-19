// Before the first paint, so a dark device never flashes the light theme. A file of its own: the site's
// Content-Security-Policy runs no inline script.
try {
  var t = JSON.parse(localStorage.getItem('theme') || '"auto"')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch (e) {}
