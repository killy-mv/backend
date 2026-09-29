// Experiment 2: fire 10,000 requests at the server, first with Redis in front
// of Postgres, then with the cache switched off, and compare.
//
//   node stress.js          database is slow (1–2s per query)
//   node stress.js --fast   database answers instantly, a fairer fight
//
// The server must already be running (npm start in another terminal).

import autocannon from 'autocannon'

const BASE = process.env.BASE_URL ?? 'http://localhost:3010'
const TOTAL = 10_000
const CONNECTIONS = 100 // 100 "users" clicking at the same time
const TIME_LIMIT_SEC = 20 // give up on a round after this long
const POPULAR = 20 // traffic is spread over the 20 most popular products
const fast = process.argv.includes('--fast')

// Stopping autocannon mid-round trips a harmless Node warning inside it. Hide just that one.
process.removeAllListeners('warning')
process.on('warning', (w) => w.name !== 'TimeoutNegativeWarning' && console.warn(w))

const post = (path, body) =>
  fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    .then((r) => r.json())
const getStats = () => fetch(BASE + '/api/stats').then((r) => r.json())

async function round(label, suffix) {
  console.log(`\n▶ ${label}: sending ${TOTAL.toLocaleString()} requests (${CONNECTIONS} at a time, max ${TIME_LIMIT_SEC}s)...`)
  await post('/api/stats/reset')

  const instance = autocannon({
    url: BASE,
    connections: CONNECTIONS,
    amount: TOTAL,
    requests: [{
      setupRequest: (req) => ({
        ...req,
        path: `/api/products/${1 + Math.floor(Math.random() * POPULAR)}${suffix}`,
      }),
    }],
  })
  const timer = setTimeout(() => instance.stop(), TIME_LIMIT_SEC * 1000)
  const result = await instance
  clearTimeout(timer)
  const stats = await getStats()

  return {
    label,
    completed: result['2xx'],
    failed: result.errors + result.timeouts + result.non2xx,
    seconds: result.duration,
    reqPerSec: Math.round(result['2xx'] / result.duration),
    avgMs: Math.round(result.latency.average),
    p99Ms: Math.round(result.latency.p99),
    dbQueries: stats.dbQueries,
  }
}

const before = await getStats()
await post('/api/settings', { slowDb: !fast })
console.log(`Database: ${fast ? 'FAST (no delay)' : 'SLOW (1–2s per query)'}`)

// Round 1: with Redis. Warm the cache first, like a real site that's been up
// for a while, so we measure steady state and not the first few misses.
await post('/api/cache/flush')
console.log(`\nWarming the cache with the ${POPULAR} popular products...`)
await Promise.all(Array.from({ length: POPULAR }, (_, i) => fetch(`${BASE}/api/products/${i + 1}`)))
const withCache = await round('With Redis', '')

// Round 2: every request goes to Postgres. This one runs last because it
// leaves the database with a backlog of queued queries.
const noCache = await round('No cache', '?cache=off')

await post('/api/settings', { slowDb: before.slowDb })

const rows = [
  ['', 'completed', 'failed', 'time', 'req/sec', 'avg', 'p99', 'DB queries'],
  ...[noCache, withCache].map((r) => [
    r.label,
    `${r.completed.toLocaleString()} / ${TOTAL.toLocaleString()}`,
    r.failed.toLocaleString(),
    `${r.seconds.toFixed(1)}s`,
    r.reqPerSec.toLocaleString(),
    `${r.avgMs.toLocaleString()}ms`,
    `${r.p99Ms.toLocaleString()}ms`,
    r.dbQueries.toLocaleString(),
  ]),
]
const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => row[c].length)))
console.log('\n' + rows.map((row) => row.map((cell, c) => cell.padEnd(widths[c])).join('   ')).join('\n'))

if (!fast) {
  console.log(`
"failed" = the client gave up after 10s waiting. Postgres can only run 10
queries at once, so 100 users waiting on 1–2s queries form a long line.
Even now, Postgres is still working through that line, computing
answers nobody is waiting for anymore.`)
}
