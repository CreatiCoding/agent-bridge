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
      await self.registration.showNotification(n?.title || 'Agent Bridge', { body: n?.text || '확인할 것이 있어요', tag: n?.sid || 'claude-bridge', data: { sid: n?.sid || '' } })
    })(),
  )
})
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = e.notification.data?.sid ? `/s/${e.notification.data.sid}` : '/'
  // A window already on the control page (any of its addresses, server/server.mjs APP_PATH) is reused.
  const app = /^\/(?:s\/[\w-]+|new|stats|quality|hosts(?:\/[\w-]+)?|admin|settings(?:\/[a-z]+)?|guide(?:\/move)?)?$/
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => app.test(new URL(c.url).pathname))
      return open ? open.focus().then((c) => c.navigate(url)) : self.clients.openWindow(url)
    }),
  )
})
