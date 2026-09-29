// Cache-aside: the app checks Redis first, and only on a miss does it ask the
// (slow) database, then saves the answer in Redis for next time. The database
// never knows the cache exists. The app is the one managing it. See ../../README.md.

import express from 'express'
import { createClient } from 'redis'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3010)
const TTL_SEC = 30 // a cached product is forgotten 30s after it was saved

const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
redis.on('error', (err) => console.error('redis:', err.message))

// Counters for the page and stress.js. They live in process memory and reset on restart.
const stats = { hits: 0, misses: 0 }

const keyFor = (id) => `product:${id}`

// ---------------------------------------------------------------------------
// The whole pattern, in one function.
// ---------------------------------------------------------------------------
async function getProduct(id) {
  const key = keyFor(id)

  // 1. Ask the cache.
  const cached = await redis.get(key)
  if (cached) {
    stats.hits++
    return { product: JSON.parse(cached), source: 'cache' }
  }

  // 2. Miss: ask the database (slow).
  stats.misses++
  const product = await db.findProduct(id)

  // 3. Save it for next time, with an expiry so it can't stay wrong forever.
  if (product) {
    await redis.set(key, JSON.stringify(product), { expiration: { type: 'EX', value: TTL_SEC } })
  }
  return { product, source: 'database' }
}

// ---------------------------------------------------------------------------
// Stampede fix: request coalescing. If a DB lookup for this key is already
// running, don't start another one. Wait for that one's answer instead.
// This Map only works inside one server process. With several servers you'd
// use a short-lived lock in Redis (SET key NX) for the same idea.
// ---------------------------------------------------------------------------
const inFlight = new Map() // key -> Promise

function getProductCoalesced(id) {
  const key = keyFor(id)
  if (inFlight.has(key)) return inFlight.get(key)
  const promise = getProduct(id).finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

// ---------------------------------------------------------------------------

const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, '..', 'src')))

// The experiment. ?cache=off skips Redis entirely (every request hits Postgres).
app.get('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id)
  const started = performance.now()

  let result
  if (req.query.cache === 'off') {
    result = { product: await db.findProduct(id), source: 'database (cache off)' }
  } else {
    result = await getProduct(id)
  }

  const ms = Math.round(performance.now() - started)
  if (!result.product) return res.status(404).json({ error: 'no such product' })
  res.set('X-Cache', result.source === 'cache' ? 'HIT' : 'MISS')
  res.json({ ...result, ms })
})

// Change a price. The right way deletes the cached copy so the next read
// fetches the new price. ?invalidate=false "forgets" to, which is the classic bug.
// Why delete and not overwrite? Two writes racing could leave the older value
// in the cache. Deleting is always safe: worst case, one extra DB read.
app.put('/api/products/:id/price', async (req, res) => {
  const id = Number(req.params.id)
  const product = await db.updatePrice(id, Number(req.body.price))
  if (!product) return res.status(404).json({ error: 'no such product' })

  const invalidate = req.query.invalidate !== 'false'
  if (invalidate) await redis.del(keyFor(id))
  res.json({ updated: product, cacheDeleted: invalidate })
})

// Experiment 4: n requests for the same cold product at the same instant.
// We call the same getProduct the route uses, n times in parallel, right here
// in the server (a browser only opens ~6 connections at a time, so it can't
// fire them simultaneously).
app.post('/api/stampede', async (req, res) => {
  const id = Number(req.body.id ?? 1)
  const n = Math.min(Number(req.body.n ?? 50), 200)
  const coalesce = Boolean(req.body.coalesce)

  await redis.del(keyFor(id)) // make sure the key is cold
  const dbBefore = db.dbQueries
  const started = performance.now()

  const fetchOne = coalesce ? getProductCoalesced : getProduct
  await Promise.all(Array.from({ length: n }, () => fetchOne(id)))

  res.json({
    requests: n,
    coalesce,
    dbQueries: db.dbQueries - dbBefore,
    totalMs: Math.round(performance.now() - started),
  })
})

app.get('/api/products', async (req, res) => {
  res.json(await db.listProducts())
})

// Look at both ends: what Postgres says vs. what Redis is holding, and how long
// until Redis forgets it (-2 = not in the cache).
app.get('/api/debug/products/:id', async (req, res) => {
  const id = Number(req.params.id)
  const key = keyFor(id)
  const [inDb, inCache, ttl] = await Promise.all([db.peekProduct(id), redis.get(key), redis.ttl(key)])
  res.json({ database: inDb, cache: inCache && JSON.parse(inCache), cacheTtlSec: ttl })
})

app.get('/api/stats', (req, res) => {
  const total = stats.hits + stats.misses
  res.json({
    ...stats,
    hitRatio: total ? Math.round((stats.hits / total) * 100) + '%' : '-',
    dbQueries: db.dbQueries,
    slowDb: db.settings.slowDb,
    ttlSec: TTL_SEC,
  })
})

app.post('/api/stats/reset', (req, res) => {
  stats.hits = stats.misses = 0
  db.resetDbQueries()
  res.json({ ok: true })
})

app.post('/api/cache/flush', async (req, res) => {
  await redis.flushDb()
  res.json({ ok: true })
})

app.post('/api/settings', (req, res) => {
  if (typeof req.body.slowDb === 'boolean') db.settings.slowDb = req.body.slowDb
  res.json(db.settings)
})

await redis.connect()
await db.setup()
app.listen(PORT, () => console.log(`cache-aside demo on http://localhost:${PORT}`))
