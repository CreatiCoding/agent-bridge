// 앱 알림 (REQ-F-774). The iOS app's notifications go through Apple's push service (APNs) over HTTP/2, authorised
// with a provider token: a JWT signed ES256 with an Apple key (.p8), made here with node's crypto alone. The same
// notices the web push carries; only the way they leave differs. Without a key, devices still register and nothing
// is sent.
import crypto from 'node:crypto'
import http2 from 'node:http2'

export const APNS_ORIGINS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' }
/** What an app device is: its token (hex), which APNs it belongs to, and whether it is a phone or a tablet. */
export const APNS_TOKEN = /^[0-9a-f]{64,200}$/
export const APNS_ENVS = ['production', 'sandbox']
export const APNS_DEVICES = ['iphone', 'ipad']

/**
 * A provider token. Apple takes one for up to an hour and refuses a new one more often than every 20 minutes, so the
 * client keeps each for 40.
 */
export function apnsJwt({ teamId, keyId, key, now = Date.now() }) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const data = `${enc({ alg: 'ES256', kid: keyId })}.${enc({ iss: teamId, iat: Math.floor(now / 1000) })}`
  return `${data}.${crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

/** A token APNs says is no longer anyone's: the app was removed, or the token was never good for this app. */
export const deadToken = (status, reason) => status === 410 || (status === 400 && reason === 'BadDeviceToken')

/** What a notice says on the lock screen. `sid` opens that session when the notification is pressed. */
export function apnsPayload(n) {
  return {
    aps: { alert: { title: String(n.title || 'Agent Bridge').slice(0, 80), body: String(n.text || '확인할 것이 있어요').slice(0, 200) }, sound: 'default', ...(n.sid ? { 'thread-id': n.sid } : {}) },
    sid: n.sid || '',
  }
}

/**
 * The web push subscriptions to post to when the person also has the app. A subscription made from an iPhone (or an
 * iPad) is that device's home-screen web app; with the app on the same kind of device it would say everything twice,
 * so it is left out. Subscriptions from before devices were recorded, and from computers, are kept.
 */
export const webTargets = (subs, devices) => {
  const app = new Set(devices.map((d) => d.dev))
  return subs.filter((s) => !s.dev || !app.has(s.dev))
}
/** iPhone or iPad from a browser's User-Agent, else ''. iPadOS Safari calls itself a Mac and is not told apart. */
export const deviceOf = (ua) => (/iPhone|iPod/.test(String(ua)) ? 'iphone' : /iPad/.test(String(ua)) ? 'ipad' : '')

/**
 * Sends to APNs with a key: team id, key id and the .p8's text. Null when any is missing. `origins` replaces Apple's
 * addresses (tests point both at a local server).
 */
export function apnsClient({ teamId, keyId, privateKey, topic, origins = APNS_ORIGINS }) {
  if (!teamId || !keyId || !privateKey || !topic) return null
  const key = crypto.createPrivateKey(privateKey.includes('BEGIN') ? privateKey : `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`)
  let jwt = null
  const bearer = () => {
    if (!jwt || Date.now() - jwt.at > 40 * 60_000) jwt = { at: Date.now(), token: apnsJwt({ teamId, keyId, key }) }
    return jwt.token
  }
  // One connection per APNs, kept open (Apple asks for that) and closed after ten idle minutes.
  const sessions = new Map()
  const session = (env) => {
    const s = sessions.get(env)
    if (s && !s.closed && !s.destroyed) return s
    const made = http2.connect(origins[env])
    made.on('error', () => sessions.delete(env))
    made.on('close', () => sessions.get(env) === made && sessions.delete(env))
    made.on('goaway', () => sessions.get(env) === made && sessions.delete(env))
    made.setTimeout(10 * 60_000, () => made.close())
    made.unref()
    sessions.set(env, made)
    return made
  }
  return {
    /** Posts one notification. Resolves to APNs' status and its reason (empty on 200). */
    send({ token, env, payload, collapseId }) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload)
        const req = session(env).request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          authorization: `bearer ${bearer()}`,
          'apns-topic': topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
          ...(collapseId ? { 'apns-collapse-id': String(collapseId).slice(0, 64) } : {}),
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        })
        let status = 0
        let text = ''
        req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL))
        req.on('response', (h) => (status = h[':status']))
        req.setEncoding('utf8')
        req.on('data', (d) => (text += d))
        req.on('end', () => {
          let reason = ''
          try {
            reason = text ? JSON.parse(text).reason ?? '' : ''
          } catch {}
          resolve({ status, reason })
        })
        // Cancelled by the timeout: no 'end' comes. A promise settles once, so after 'end' this does nothing.
        req.on('close', () => resolve({ status, reason: status ? '' : 'Timeout' }))
        req.on('error', reject)
        req.end(body)
      })
    },
    close() {
      for (const s of sessions.values()) s.close()
      sessions.clear()
    },
  }
}
