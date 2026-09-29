// A router is a lookup table: (method, path) -> handler. This one is written by
// hand, no Express, so every step of the lookup is visible. See README.md.

export class Router {
  #routes = []     // { method, pattern, segments, handlers }
  #middleware = [] // runs before every handler this router dispatches to

  use(fn) {
    this.#middleware.push(fn)
    return this
  }

  get(pattern, ...handlers) { return this.add('GET', pattern, handlers) }
  post(pattern, ...handlers) { return this.add('POST', pattern, handlers) }
  put(pattern, ...handlers) { return this.add('PUT', pattern, handlers) }
  patch(pattern, ...handlers) { return this.add('PATCH', pattern, handlers) }
  delete(pattern, ...handlers) { return this.add('DELETE', pattern, handlers) }

  add(method, pattern, handlers) {
    this.#routes.push({ method, pattern, segments: split(pattern), handlers })
    return this
  }

  // Sub-router: every route of `child` is copied in with `prefix` in front, and
  // the child's own middleware prepended to its handlers. So it only runs for
  // the child's routes. Configure the child fully before mounting it.
  mount(prefix, child) {
    for (const r of child.#routes) {
      this.add(r.method, joinPath(prefix, r.pattern), [...child.#middleware, ...r.handlers])
    }
    return this
  }

  // The route table, as the router sees it (served at GET / in server.mjs).
  table() {
    return this.#routes.map((r) => `${r.method.padEnd(6)} ${r.pattern}`)
  }

  // The actual routing decision. Returns one of:
  //   { status: 200, route, params }
  //   { status: 404 }                 no pattern matches the path at all
  //   { status: 405, allow: [...] }   the path exists, just not with this method
  find(method, pathname) {
    const parts = split(pathname)

    const pathMatches = []
    for (const route of this.#routes) {
      const params = matchSegments(route.segments, parts)
      if (params) pathMatches.push({ route, params })
    }
    if (pathMatches.length === 0) return { status: 404 }

    // HEAD is GET without a body, so any GET route answers it.
    const wanted = method === 'HEAD' ? 'GET' : method
    const candidates = pathMatches.filter((m) => m.route.method === wanted)
    if (candidates.length === 0) {
      return { status: 405, allow: [...new Set(pathMatches.map((m) => m.route.method))] }
    }

    // Several patterns can match one path: /books/featured matches both
    // "/books/featured" and "/books/:id". The most specific one wins,
    // whatever order they were registered in.
    candidates.sort((a, b) => compareSpecificity(a.route.segments, b.route.segments))
    return { status: 200, ...candidates[0] }
  }

  // The (req, res) function node:http calls for every request.
  handler() {
    return async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      req.path = url.pathname
      req.query = Object.fromEntries(url.searchParams)

      const dispatch = (req, res) => this.#dispatch(req, res)
      try {
        await runChain([...this.#middleware, dispatch], req, res)
      } catch (err) {
        console.error(`handler error: ${err.message}`)
        if (!res.headersSent) json(res, 500, { error: 'internal server error' })
      }
    }
  }

  async #dispatch(req, res) {
    let found
    try {
      found = this.find(req.method, req.path)
    } catch {
      return json(res, 400, { error: 'malformed URL', path: req.path }) // bad %-encoding
    }

    if (found.status === 404) {
      return json(res, 404, { error: 'not found', method: req.method, path: req.path })
    }
    if (found.status === 405) {
      res.setHeader('Allow', found.allow.join(', '))
      return json(res, 405, { error: 'method not allowed', method: req.method, allow: found.allow })
    }

    req.params = found.params
    req.route = `${found.route.method} ${found.route.pattern}`
    res.setHeader('X-Matched-Route', req.route) // so you can see the decision from outside
    await runChain(found.route.handlers, req, res)
  }
}

// "/api/books/" -> ["api", "books"]. Dropping empty segments is what makes the
// trailing slash (and "//") not matter.
function split(path) {
  return path.split('/').filter(Boolean)
}

function joinPath(prefix, pattern) {
  return '/' + [...split(prefix), ...split(pattern)].join('/')
}

// Pattern ["books", ":id"] vs path ["books", "42"] -> { id: "42" }, or null.
function matchSegments(segments, parts) {
  if (segments.length !== parts.length) return null
  const params = {}
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i])
    else if (seg !== parts[i]) return null
  }
  return params
}

// Left to right, the first segment where one pattern is static and the other a
// parameter decides it: static is more specific.
function compareSpecificity(a, b) {
  for (let i = 0; i < a.length; i++) {
    const aParam = a[i].startsWith(':')
    const bParam = b[i].startsWith(':')
    if (aParam !== bParam) return aParam ? 1 : -1
  }
  return 0
}

// Middleware and handlers share one signature: (req, res, next). Each one
// either responds or calls next() to hand over to the following one.
async function runChain(chain, req, res) {
  let i = 0
  const next = async () => {
    const fn = chain[i++]
    if (fn) await fn(req, res, next)
  }
  await next()
}

export function json(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body, null, 2))
}
