// JWT: log in once, get a signed token that CONTAINS your identity. The server
// verifies the signature and never looks anything up. See ../../README.md §6.
//
// Signing and verifying are written by hand (no jsonwebtoken library) -- it's
// base64url + one HMAC, and seeing that is the whole lesson.

import express from 'express'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPassword, findUser } from '../../users.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3003)

// Whoever holds this can mint tokens for anyone. A random one per start means
// restarting the server invalidates every token -- set JWT_SECRET to avoid that.
const SECRET = process.env.JWT_SECRET ?? randomBytes(32)
const ACCESS_TTL_SEC = 60 // absurdly short so you can watch it expire
const REFRESH_TTL_SEC = 24 * 60 * 60
const REFRESH_COOKIE = 'rt'

// Refresh tokens ARE server-side state -- the price of being able to log out
// (README §6). Process memory for the demo; Redis or the DB in real life.
const refreshTokens = new Map() // token -> { username, expiresAt }

const app = express()

app.use(express.json())
app.use(express.static(join(__dirname, '..', 'src')))

// ---- the entire JWT implementation --------------------------------------

const b64url = (value) => Buffer.from(value).toString('base64url')
const hmac = (data) => createHmac('sha256', SECRET).update(data).digest()

function sign(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  return `${header}.${body}.${b64url(hmac(`${header}.${body}`))}`
}

// Throws with a reason. Each check below is a real-world bug when skipped.
function verify(token) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed token')
  const [header, body, signature] = parts

  // Pin the algorithm. Never let the token choose -- "alg":"none" means
  // "no signature, trust me", and libraries have shipped bugs accepting it.
  const { alg } = JSON.parse(Buffer.from(header, 'base64url'))
  if (alg !== 'HS256') throw new Error(`algorithm "${alg}" not accepted`)

  // Recompute and compare. Editing a single byte of the payload breaks this.
  const expected = hmac(`${header}.${body}`)
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error('invalid signature')
  }

  // Only now is the payload trustworthy enough to read.
  const payload = JSON.parse(Buffer.from(body, 'base64url'))
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
    throw new Error('token expired')
  }
  return payload
}

// -------------------------------------------------------------------------

function issueAccessToken(user) {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub: user.username, role: user.role, iat: now, exp: now + ACCESS_TTL_SEC })
}

// Opaque and random, not a JWT: it only ever goes back to this server, which
// looks it up anyway. HttpOnly + Path=/api/auth -> JS can't read it, and the
// browser only sends it to the login/refresh/logout endpoints.
function issueRefreshToken(res, username) {
  const token = randomBytes(32).toString('base64url')
  refreshTokens.set(token, { username, expiresAt: Date.now() + REFRESH_TTL_SEC * 1000 })
  setRefreshCookie(res, token, REFRESH_TTL_SEC)
}

function setRefreshCookie(res, token, maxAgeSec) {
  // Add `Secure` in production -- left off only because this runs on plain http.
  res.append(
    'Set-Cookie',
    `${REFRESH_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=${maxAgeSec}`
  )
}

function readRefreshCookie(req) {
  const match = (req.get('Cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${REFRESH_COOKIE}=([^;]+)`))
  return match?.[1]
}

// Authentication middleware: no store, no DB -- just a signature check.
function requireAuth(req, res, next) {
  const [scheme, token] = (req.get('Authorization') ?? '').split(' ')
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'unauthenticated' })
  try {
    const claims = verify(token)
    req.user = { username: claims.sub, role: claims.role }
    req.claims = claims
    next()
  } catch (err) {
    // Real APIs just say 401; the reason is exposed here so you can see which check failed.
    res.status(401).json({ error: 'unauthenticated', reason: err.message })
  }
}

function requireAdmin(req, res, next) {
  // The role comes from the token itself. That's only safe because verify()
  // proved nobody edited it -- try the "tamper" button on the page.
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden', youAre: req.user })
  next()
}

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body ?? {}
  const user = await checkPassword(username, password)
  if (!user) return res.status(401).json({ error: 'invalid username or password' })

  issueRefreshToken(res, user.username)
  console.log(`login ${user.username}`)
  res.json({ accessToken: issueAccessToken(user), expiresIn: ACCESS_TTL_SEC })
})

// Trade the long-lived refresh token for a fresh short-lived access token.
// This is the one place the server looks something up.
app.post('/api/auth/refresh', (req, res) => {
  const token = readRefreshCookie(req)
  const entry = token && refreshTokens.get(token)
  if (!entry || entry.expiresAt <= Date.now()) {
    if (token) refreshTokens.delete(token)
    return res.status(401).json({ error: 'no valid refresh token -- log in again' })
  }

  // Rotation: each refresh token works once. A stolen one that gets used
  // leaves the real user's copy dead, which is noticeable.
  refreshTokens.delete(token)
  const user = findUser(entry.username) // re-read: a changed role takes effect here
  if (!user) return res.status(401).json({ error: 'user no longer exists' })
  issueRefreshToken(res, user.username)
  res.json({ accessToken: issueAccessToken(user), expiresIn: ACCESS_TTL_SEC })
})

app.post('/api/auth/logout', (req, res) => {
  const token = readRefreshCookie(req)
  if (token) refreshTokens.delete(token)
  setRefreshCookie(res, '', 0)
  // Note what we CAN'T do: the access token already out there stays valid
  // until its exp. The server has nowhere to delete it from.
  res.json({ loggedOut: true, butAccessTokenStillValidForUpTo: `${ACCESS_TTL_SEC}s` })
})

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    user: req.user,
    claims: req.claims,
    expiresInSec: req.claims.exp - Math.floor(Date.now() / 1000),
    serverLookedUp: 'nothing -- the token carried everything',
  })
})

app.get('/api/admin', requireAuth, requireAdmin, (req, res) => {
  res.json({ secret: 'the admin area', user: req.user })
})

// Compare with the session demo: this kills future refreshes, but any access
// token already issued keeps working until it expires.
app.post('/api/admin/revoke/:username', requireAuth, requireAdmin, (req, res) => {
  let revoked = 0
  for (const [token, entry] of refreshTokens) {
    if (entry.username === req.params.username) {
      refreshTokens.delete(token)
      revoked++
    }
  }
  res.json({ revokedRefreshTokens: revoked, accessTokensStillValidForUpTo: `${ACCESS_TTL_SEC}s` })
})

app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.originalUrl })
})

// Malformed JSON bodies land here. Without this, Express answers with an HTML
// page containing a stack trace -- a leak, and useless to a fetch() caller.
app.use((err, req, res, next) => {
  const status = err.status ?? 500
  if (status >= 500) console.error(err)
  res.status(status).json({ error: status < 500 ? err.message : 'internal error' })
})

app.listen(PORT, () => {
  console.log(`jwt auth demo on http://localhost:${PORT}`)
})
