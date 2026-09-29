// Basic auth: no login step, no session, no token. The password rides along on
// EVERY request and is checked -- slowly -- every time. See ../../README.md §4.

import express from 'express'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPassword } from '../../users.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3001)
const REALM = 'basic-demo'

const app = express()

app.use(express.static(join(__dirname, '..', 'src')))

// A 401 with WWW-Authenticate is what makes a browser show its built-in login
// popup. Our page's fetch() calls send X-Requested-With, so for those we leave
// the header off and let the page render the error itself.
function challenge(req, res) {
  if (req.get('X-Requested-With') !== 'fetch') {
    res.set('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`)
  }
  res.status(401).json({ error: 'unauthenticated' })
}

// Authentication middleware: credential in, req.user out (or 401).
async function requireAuth(req, res, next) {
  const header = req.get('Authorization') ?? ''
  const [scheme, encoded] = header.split(' ')
  if (scheme !== 'Basic' || !encoded) return challenge(req, res)

  // Decoding, not decrypting. Anyone who sees this header can do the same.
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const sep = decoded.indexOf(':') // usernames can't contain ':', passwords can
  if (sep === -1) return challenge(req, res)
  const username = decoded.slice(0, sep)
  const password = decoded.slice(sep + 1)

  // The cost of Basic: a deliberately slow hash on every single request.
  const start = performance.now()
  const user = await checkPassword(username, password)
  const checkMs = Number((performance.now() - start).toFixed(1))
  console.log(`password check for "${username}": ${user ? 'ok' : 'FAILED'} in ${checkMs}ms`)

  if (!user) return challenge(req, res)
  req.user = user
  req.auth = { header, decoded, checkMs }
  next()
}

app.get('/api/public', (req, res) => {
  res.json({ message: 'anyone can read this', youSent: req.get('Authorization') ?? null })
})

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    user: req.user,
    // Echoing the password back is absurd in real life -- here it's the point:
    // this is what anyone on the path can read if you skip HTTPS.
    youSent: { authorization: req.auth.header, decodedByAnyone: req.auth.decoded },
    passwordCheckMs: req.auth.checkMs,
  })
})

// Authorization: authenticated is not enough, the role must match.
app.get('/api/admin', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden', youAre: req.user })
  }
  res.json({ secret: 'the admin area', user: req.user })
})

app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.originalUrl })
})

app.listen(PORT, () => {
  console.log(`basic auth demo on http://localhost:${PORT}`)
})
