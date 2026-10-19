// Apple로 로그인 (REQ-F-772). The iOS app asks the system for an Apple ID credential and hands its identity token
// (a JWT signed by Apple) to this server, which checks it here with node's crypto alone: the signature against
// Apple's published keys (RS256), who issued it, which app it is for, that it has not run out, and the nonce this
// server gave out for that one sign-in.
// With a Sign in with Apple key (.p8) configured, the authorization code that comes with it is traded for a refresh
// token, kept so that deleting the account can revoke it (App Store guideline 5.1.1(v)). Without a key both are skipped.
import crypto from 'node:crypto'

export const APPLE_ISSUER = 'https://appleid.apple.com'
const KEYS_URL = `${APPLE_ISSUER}/auth/keys`

export class AppleTokenError extends Error {}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
export const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

/**
 * Apple's public keys by kid, fetched when a token names one not seen yet (Apple rotates them) and otherwise kept an
 * hour. `fetchJson` is there for tests.
 */
export function appleKeys({ fetchJson = (u) => fetch(u).then((r) => r.json()), ttl = 3_600_000 } = {}) {
  let keys = new Map()
  let at = 0
  return async (kid) => {
    if (!keys.has(kid) || Date.now() - at > ttl) {
      const j = await fetchJson(KEYS_URL)
      keys = new Map((j?.keys ?? []).filter((k) => k.kty === 'RSA' && k.kid).map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]))
      at = Date.now()
    }
    return keys.get(kid) ?? null
  }
}

/**
 * The claims of an identity token that is Apple's, for `audience` (the app's bundle id), still in date, and carrying
 * `nonce` (what the app put in its request: sha256 hex of the raw nonce this server gave out). Throws AppleTokenError
 * otherwise. `keyOf(kid)` gives Apple's public key for a kid.
 */
export async function verifyIdentityToken(token, { audience, nonce, keyOf, now = Date.now() }) {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 3) throw new AppleTokenError('토큰 모양이 아닙니다')
  let head, claims
  try {
    head = b64json(parts[0])
    claims = b64json(parts[1])
  } catch {
    throw new AppleTokenError('토큰을 읽지 못했습니다')
  }
  // Only RS256: a token that names another algorithm (none, HS256 with the public key as secret) is not looked at.
  if (head?.alg !== 'RS256' || typeof head.kid !== 'string') throw new AppleTokenError('서명 방식이 맞지 않습니다')
  const key = await keyOf(head.kid)
  if (!key) throw new AppleTokenError('모르는 서명 키입니다')
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))
  if (!ok) throw new AppleTokenError('서명이 맞지 않습니다')
  if (claims.iss !== APPLE_ISSUER) throw new AppleTokenError('발급자가 맞지 않습니다')
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(audience)) throw new AppleTokenError('이 앱의 토큰이 아닙니다')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) throw new AppleTokenError('토큰이 만료됐습니다')
  if (!nonce || typeof claims.nonce !== 'string' || !crypto.timingSafeEqual(Buffer.from(sha256hex(claims.nonce)), Buffer.from(sha256hex(nonce))))
    throw new AppleTokenError('로그인 요청이 맞지 않습니다')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new AppleTokenError('계정 정보가 없습니다')
  return claims
}

/** This server's names for an Apple account: never a GitHub name, which has no `_` (R: an Apple user takes no one's name). */
export function appleIds(sub) {
  const h = sha256hex(`apple|${sub}`)
  return { uid: `ap${h.slice(0, 24)}`, login: `apple_${h.slice(0, 10)}` }
}
export const isAppleLogin = (login) => /^apple_[0-9a-f]{10}$/.test(String(login ?? '').toLowerCase())

/**
 * Talks to Apple's token and revoke endpoints with a client secret signed by the Sign in with Apple key. Null when
 * the key is not configured (APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY).
 */
export function appleClient({ teamId, keyId, privateKey, clientId, post = postForm }) {
  if (!teamId || !keyId || !privateKey || !clientId) return null
  const key = crypto.createPrivateKey(privateKey.includes('BEGIN') ? privateKey : `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`)
  const secret = () => {
    const iat = Math.floor(Date.now() / 1000)
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const data = `${enc({ alg: 'ES256', kid: keyId })}.${enc({ iss: teamId, iat, exp: iat + 300, aud: APPLE_ISSUER, sub: clientId })}`
    return `${data}.${crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
  }
  return {
    /** The refresh token for an authorization code (good for five minutes after sign-in), or null. */
    async refreshToken(code) {
      if (!code) return null
      const r = await post(`${APPLE_ISSUER}/auth/token`, { client_id: clientId, client_secret: secret(), code, grant_type: 'authorization_code' })
      return r.ok && typeof r.json?.refresh_token === 'string' ? r.json.refresh_token : null
    },
    /** Revokes a refresh token: the app no longer appears under the person's Apple ID. True when Apple said yes. */
    async revoke(token) {
      const r = await post(`${APPLE_ISSUER}/auth/revoke`, { client_id: clientId, client_secret: secret(), token, token_type_hint: 'refresh_token' })
      return r.ok
    },
  }
}

async function postForm(url, fields) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), signal: AbortSignal.timeout(10_000) })
  let json = null
  try {
    json = await r.json()
  } catch {}
  return { ok: r.ok, status: r.status, json }
}
