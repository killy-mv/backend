# Caching

A cache is a small, fast memory placed in front of something slow. Instead of
asking the slow thing the same question again and again, you remember the
answer for a while. That's the whole idea. Everything else is about the two
hard parts: **when to forget** and **what happens when the memory is wrong**.

## Run the demo

A small shop: a web page, an Express server, a real **Postgres** holding 1,000
products, and **Redis** in between as the cache. Postgres is made slow on
purpose (each product lookup takes 1–2s), like a heavy query in a real app.

```
caching/
├── docker-compose.yml       Postgres + Redis
└── cache-aside/
    ├── server/
    │   ├── db.js            the database: seeding + the deliberately slow query
    │   ├── server.js        the cache-aside pattern + the experiment routes
    │   └── stress.js        the 10,000-request stress test
    └── src/index.html       the page -> http://localhost:3010
```

```powershell
cd caching
docker compose up -d                 # start Postgres + Redis
cd cache-aside/server
npm install
npm start                            # then open http://localhost:3010
```

When you're done: `docker compose down -v` in `caching/` stops both and deletes the data.

## The pattern: cache-aside

```
          ┌── 1. "got product 7?" ──▶  Redis ── yes ──▶ answer  (HIT, ~1ms)
  server ─┤
          └── no (MISS) ──▶ 2. ask Postgres (1–2s) ──▶ 3. save in Redis for 30s ──▶ answer
```

The app manages the cache itself, and the database doesn't know Redis exists.
It's the most common caching pattern. The code is `getProduct()` in
`server.js`, about 15 lines.

## The experiments

### 1. Slow database vs. cache (on the page)
Click a product: **MISS, ~1500ms**. Click it again: **HIT, ~1ms**. That
difference is the reason caches exist. Wait 30 seconds and it's a MISS again,
because the cached copy **expired (TTL)**.

### 2. Stress test: 10,000 requests (in a terminal)
```powershell
npm run stress          # slow database
npm run stress:fast     # instant database
```
100 simulated users request the 20 most popular products, 10,000 requests in
total, first through Redis and then straight to Postgres. Results from this machine:

**Slow database (1–2s per query):**
```
             completed         failed   time    req/sec   avg       p99       DB queries
No cache     63 / 10,000       274      20.2s   3         5,416ms   9,819ms   300
With Redis   10,000 / 10,000   0        2.0s    4,902     18ms      40ms      0
```
Without a cache the site basically falls over. Postgres can only run 10
queries at once (the connection pool), so 100 users form a queue, wait up to
10s, and give up. With Redis, all 10,000 are served in 2 seconds and Postgres
isn't touched at all.

**Fast database (no delay):**
```
             completed         failed   time   req/sec   avg    p99    DB queries
No cache     10,000 / 10,000   0        5.0s   1,992     44ms   80ms   10,000
With Redis   10,000 / 10,000   0        2.0s    4,926    16ms   34ms   0
```
Redis still wins, but by about 2.5× instead of about 1,600×. **The slower the
thing behind the cache, the more the cache is worth.** It also takes 10,000
queries of load off the database, so the database stays free for writes.

### 3. The cache lies to you: stale data (on the page)
Load a product (so it's cached), then click **"Change price, forget the cache"**.
Load it again: you get the **old price**, marked ⚠ STALE. "Look at both ends"
shows Postgres with the new price and Redis with the old one, plus the seconds
until Redis forgets it.

The fix is **"Change price + delete from cache"**. After writing to the
database, delete the cached copy so the next read fetches the fresh one.

- **Delete, don't overwrite.** Two updates racing could leave the older value in
  the cache. A delete is always safe. The worst case is one extra DB read.
- **The TTL is your safety net.** If you forget to invalidate somewhere, the
  wrong answer only lives for 30 seconds, not forever.

### 4. Everyone rushes in at once: stampede (on the page)
Empties the cache for product 1, then fires 50 requests for it at the same instant:
```
Stampede               50 requests → 50 database queries, ~7,800ms
Stampede + coalescing  50 requests →  1 database query,   ~1,500ms
```
All 50 check Redis, all 50 miss (nobody has filled it yet), and all 50 hit the
database. This happens in real life when a popular item's cache entry expires
during peak traffic. **Coalescing** fixes it: the first request goes to the
database, and the other 49 wait for its answer. The demo does this with a
`Map` of in-flight promises, which only works inside one server. With several
servers you'd use a short lock in Redis (`SET key NX`) for the same idea.

## Words you'll see

| Term | Meaning |
|---|---|
| **Hit / miss** | the cache had it / the cache didn't have it |
| **Hit ratio** | hits ÷ all lookups. Real sites aim for 90%+ |
| **TTL** (time to live) | how long a cached copy is kept before it's forgotten |
| **Invalidation** | deleting a cached copy because the real data changed |
| **Stale** | the cached copy no longer matches the database |
| **Stampede** | many misses for the same key at once, all hitting the database |
| **Eviction** | the cache is full and throws out old entries (usually least recently used, "LRU") |

## Where caches live in a real stack

This demo is layer 4. Real systems usually cache at several layers:

1. **Browser**: `Cache-Control` / `ETag` headers
2. **CDN** (Cloudflare, CloudFront): copies near the user
3. **Reverse proxy** (Nginx, Varnish)
4. **Shared app cache**: **Redis** / Valkey / Memcached ← *this demo*
5. **In-process memory**: an LRU map inside the server itself
6. **Database**: its own buffer cache, materialized views
