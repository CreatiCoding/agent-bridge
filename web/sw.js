// The service worker exists for one thing: a push wakes it, and it asks the server (same origin, signed in) what
// there is to say. A push carries no content of its own.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('push', (e) => {
  e.waitUntil(
    (async () => {
      let n = null
      try {
        const r = await fetch('/api/notices', { credentials: 'same-origin' })
        n = r.ok ? (await r.json()).notices[0] : null
      } catch {}
      // A permission request carries its card's allow and deny (REQ-F-797): answered from the notification itself.
      // Browsers that draw no buttons (Safari) show it as before, and a tap opens the session.
      const act = n?.act && n.sid ? n.act : null
      await self.registration.showNotification(n?.title || 'Agent Bridge', {
        body: n?.text || '확인할 것이 있어요',
        tag: n?.sid || 'claude-bridge',
        data: { sid: n?.sid || '', act },
        ...(act ? { actions: [{ action: 'allow', title: '허용' }, { action: 'deny', title: '거부' }], requireInteraction: true } : {}),
      })
    })(),
  )
})
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const { sid, act } = e.notification.data ?? {}
  const url = sid ? `/s/${sid}` : '/'
  // A window already on the control page (any of its addresses, server/server.mjs APP_PATH) is reused.
  const app = /^\/(?:s\/[\w-]+|new|stats|quality|hosts(?:\/[\w-]+)?|admin|settings(?:\/[a-z]+)?|guide(?:\/move)?)?$/
  const openPage = () =>
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => app.test(new URL(c.url).pathname))
      return open ? open.focus().then((c) => c.navigate(url)) : self.clients.openWindow(url)
    })
  if (act && (e.action === 'allow' || e.action === 'deny')) {
    // The agent presses the option only while that very card is open; a late tap is told so on the session page.
    e.waitUntil(
      fetch(`/api/sessions/${encodeURIComponent(sid)}/answer`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card: act.card, n: e.action === 'allow' ? act.allow : act.deny }) })
        .then((r) => (r.ok ? self.registration.showNotification(e.action === 'allow' ? '허용했어요' : '거부했어요', { body: e.notification.body, tag: sid, silent: true }) : openPage()))
        .catch(openPage),
    )
    return
  }
  e.waitUntil(openPage())
})
