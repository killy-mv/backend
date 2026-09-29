// An application server: we supply the do_work() of the accept loop.
// Node owns socket/bind/listen/accept; Express turns bytes into req/res.
// See ../README.md sections 3 and 7.

import express from 'express'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3000)

const app = express()

app.use(express.json())

// Access log. Every line here is one turn of the accept loop.
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    console.log(
      `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`
    )
  })
  next()
})

// Stand-in for a database. Section 5: this is process memory, so it dies on
// restart and is NOT shared if you run two copies. That is the whole point.
const users = [
  { id: 1, name: 'Ada Lovelace', role: 'admin' },
  { id: 2, name: 'Alan Turing', role: 'user' },
  { id: 3, name: 'Grace Hopper', role: 'user' },
]
let nextId = 4

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', server: 'express', pid: process.pid, uptime: process.uptime() })
})

app.get('/api/users', (req, res) => {
  res.json(users)
})

app.get('/api/users/:id', (req, res) => {
  const user = users.find((u) => u.id === Number(req.params.id))
  if (!user) return res.status(404).json({ error: 'user not found' })
  res.json(user)
})

app.post('/api/users', (req, res) => {
  const { name, role } = req.body ?? {}
  // Section 8: every byte here came from someone you do not trust.
  if (typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'name is required and must be a string' })
  }
  const user = { id: nextId++, name: name.trim(), role: role === 'admin' ? 'admin' : 'user' }
  users.push(user)
  res.status(201).json(user)
})

// Shows what a reverse proxy adds to the request. Hit this directly on :3000,
// then through nginx on :8080, and diff the headers you get back.
app.get('/api/whoami', (req, res) => {
  res.json({
    servedBy: 'express',
    remoteAddress: req.socket.remoteAddress,
    forwardedFor: req.headers['x-forwarded-for'] ?? null,
    realIp: req.headers['x-real-ip'] ?? null,
    forwardedProto: req.headers['x-forwarded-proto'] ?? null,
    host: req.headers.host,
    headers: req.headers,
  })
})

// Section 6: WAITING. Open 10 of these at once -- they all finish together,
// because an idle await costs the event loop almost nothing.
app.get('/api/slow', async (req, res) => {
  const ms = Math.min(Number(req.query.ms ?? 2000), 30000)
  await new Promise((resolve) => setTimeout(resolve, ms))
  res.json({ waited: ms, pid: process.pid })
})

// Section 6: COMPUTING. Open 10 of these at once -- they finish one after
// another, and /api/health stops responding while they run. This is the cost
// of the single-threaded event loop.
app.get('/api/block', (req, res) => {
  const ms = Math.min(Number(req.query.ms ?? 2000), 30000)
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* deliberately hogging the only thread */
  }
  res.json({ blocked: ms, pid: process.pid })
})

// Express CAN serve static files, but this is the job nginx/apache do far
// better. Same folder is mounted into both containers, so all three servers
// serve byte-identical files.
app.use(express.static(join(__dirname, '..', 'public')))

app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.originalUrl })
})

const server = app.listen(PORT, () => {
  console.log(`express listening on http://localhost:${PORT}  (pid ${process.pid})`)
})

// Section 8: finish in-flight requests instead of cutting connections dead.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, closing server`)
    server.close(() => process.exit(0))
  })
}
