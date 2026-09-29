// Sessions: log in once, get a random id in a cookie, and the server looks that
// id up on every request. All the truth lives server-side. See ../../README.md §5.
//
// Cookies are parsed and written by hand (no cookie-parser, no express-session)
// so nothing is hidden: it's all just headers.

import express from 'express'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPassword } from '../../users.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3002)
const COOKIE = 'sid'
const SESSION_TTL_SEC = 30 * 60

// The session store. Process memory, exactly like ../../../server/README.md §5
// warns: restart the server and everyone is logged out; run two copies and
// each has its own store. Real deployments put this in Redis or the database.
const sessions = new Map() // sid -> { username, role, createdAt, expiresAt }

const app = express()

app.use(express.json())
app.use(express.static(join(__dirname, '..', 'src')))

function parseCookies(header = '') {
  const cookies = {}
  for (const pair of header.split(';')) {
    const i = pair.indexOf('=')
    if (i === -1) continue
    cookies[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
  }
  return cookies
}

// HttpOnly: JS can't read it, so XSS can't steal it.
// SameSite=Lax: not sent on cross-site POSTs, which blocks CSRF.
// Add `Secure` in production -- it's left off only because this runs on plain http.
function setSessionCookie(res, sid, maxAgeSec) {
  res.append('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`)
}

// Runs on every request: cookie -> store lookup -> req.user.
app.use((req, res, next) => {
  const sid = parseCookies(req.get('Cookie'))[COOKIE]
  const session = sid && sessions.get(sid)
  if (session && session.expiresAt <= Date.now()) sessions.delete(sid)
  else if (session) {
    req.sid = sid
    req.user = { username: session.username, role: session.role }
  }
  next()
})

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' })
  next()
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden', youAre: req.user })
  next()
}

const preview = (sid) => `${sid.slice(0, 6)}...`

// The expensive credential (password) is checked ONCE, here.
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body ?? {}
  const user = await checkPassword(username, password)
  if (!user) return res.status(401).json({ error: 'invalid username or password' })

  // Drop any session this browser already had; always issue a fresh id at
  // login (reusing one lets an attacker plant an id before you log in).
  if (req.sid) sessions.delete(req.sid)

  // The cheap credential: 256 random bits that mean nothing on their own.
  const sid = randomBytes(32).toString('base64url')
  const now = Date.now()
  sessions.set(sid, { ...user, createdAt: now, expiresAt: now + SESSION_TTL_SEC * 1000 })
  setSessionCookie(res, sid, SESSION_TTL_SEC)
  console.log(`login ${user.username} -> session ${preview(sid)}`)
  res.json({ user })
})

app.post('/api/auth/logout', (req, res) => {
  // Deleting the row IS the logout. The cookie could survive; it points at nothing.
  if (req.sid) sessions.delete(req.sid)
  setSessionCookie(res, '', 0)
  res.json({ loggedOut: true })
})

app.get('/api/me', requireAuth, (req, res) => {
  const session = sessions.get(req.sid)
  res.json({
    user: req.user,
    youSent: { cookie: req.get('Cookie') },
    serverLookedUp: { sid: preview(req.sid), ...session },
  })
})

app.get('/api/admin', requireAuth, requireAdmin, (req, res) => {
  res.json({ secret: 'the admin area', user: req.user })
})

// Instant revocation -- the thing JWTs can't do. Log in as alan in one browser
// and as ada in another, revoke alan, and his next click gets a 401.
app.post('/api/admin/revoke/:username', requireAuth, requireAdmin, (req, res) => {
  let revoked = 0
  for (const [sid, session] of sessions) {
    if (session.username === req.params.username) {
      sessions.delete(sid)
      revoked++
    }
  }
  res.json({ revoked, note: 'their very next request is unauthenticated' })
})

// DEBUG ONLY -- never expose a session store. Here to make the server-side
// state visible. Ids are truncated so this can't be used to hijack anyone.
app.get('/api/debug/sessions', (req, res) => {
  res.json([...sessions].map(([sid, s]) => ({ sid: preview(sid), ...s, isYou: sid === req.sid })))
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
  console.log(`session auth demo on http://localhost:${PORT}`)
})
