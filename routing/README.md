# Routing

A request arrives as a method and a URL. Routing is the step that turns that
into **which function runs**. It's a lookup table:

```
(method, path)            ->  handler
GET    /api/books         ->  list books
GET    /api/books/:id     ->  get one book
POST   /api/books         ->  create a book
DELETE /api/books/:id     ->  delete a book
```

## Run the example

No dependencies, no Express. The router is ~150 lines in `router.mjs`, so
there's nothing hidden.

```
routing/
├── router.mjs   the router: matching, params, precedence, 404/405, middleware, mounting
├── server.mjs   a books API built with it   -> http://localhost:3004
└── demo.mjs     fires 14 requests and prints what the router decided for each
```

```bash
node demo.mjs      # the fastest way to see everything below
node server.mjs    # or run it and poke at it yourself; GET / lists the route table
```

```bash
curl -i localhost:3004/api/books/featured
curl -i "localhost:3004/api/books?author=2&sort=year"
curl -i -X PUT localhost:3004/api/books/1                     # 405 + Allow header
curl -i -X POST localhost:3004/api/books -H "x-api-key: demo" \
     -H "content-type: application/json" -d '{"title":"Mort","authorId":"2"}'
```

Every response carries an `X-Matched-Route` header, and the server log prints
the matched route next to each request.

## 1. What the router looks at

```
POST /api/books/42?draft=true
└┬─┘ └─────┬─────┘ └───┬────┘
method    path       query string
```

- **Method + path** decide the route.
- **The query string does not.** `/api/books` and `/api/books?author=2` hit the
  same route. The query just arrives as `req.query` for the handler to use
  (filtering, sorting, paging).

The same path with different methods gives different routes: `GET /api/books/:id`
reads, `DELETE /api/books/:id` deletes. That's REST's idea: **the path names
the thing, the method names the action.**

## 2. Matching: segments and parameters

Both the pattern and the path are split on `/` and compared segment by segment
(`matchSegments` in router.mjs):

```
pattern:  api  books  :id        static segments must be equal,
path:     api  books  42         :param segments match anything
                      └─> req.params = { id: "42" }
```

- Segment counts must be equal, so `/api/books/1/extra` does not match `/api/books/:id`.
- Empty segments are dropped, so `/api/books/` and `/api/books` are the same.
  Frameworks differ here: some redirect, some treat them as distinct.
- Params are always **strings**, and they come from the user. Validate them.
- A path can hold several: `/api/authors/:authorId/books/:bookId`.

## 3. Precedence: when two patterns match

`/api/books/featured` matches both `/api/books/featured` and `/api/books/:id`.
In server.mjs, `:id` is registered **first**, on purpose.

- **First-match routers** (Express, most older ones) try routes in order, so
  that path would hit `:id` with `id = "featured"`. You'd have to remember to
  register the static route first.
- **Most-specific-wins routers** (this one, Fastify, Go 1.22's `ServeMux`)
  prefer the static segment regardless of order. See `compareSpecificity`.

This is a classic source of "why does my route never get called" bugs.

## 4. When nothing matches: 404 vs 405

The router's answer is one of three things (`find` in router.mjs):

| Situation | Response |
|---|---|
| a pattern matches path + method | run its handlers |
| no pattern matches the **path** | `404 Not Found` |
| the path matches, but not with this **method** | `405 Method Not Allowed` + `Allow: GET, PATCH, DELETE` |

Don't confuse a *router* 404 with a *handler* 404: `GET /api/books/99`
**matched** `GET /api/books/:id` fine. The handler then looked in the data and
found no book 99. Same status code, different layer.

`HEAD` is answered by the matching `GET` route. Node drops the body for you.

## 5. Middleware: code that runs before the handler

A route has a *chain* of functions, not just one. Each is `(req, res, next)`
and either responds or calls `next()` to pass the request on (`runChain`).
In server.mjs there are three levels:

```
request
  │
  ├─ global      logger, jsonBody       app.use(...)            every request, even 404s
  ├─ router      stampApiVersion        booksRouter.use(...)    every /api/books/* route
  ├─ route       requireApiKey          .post('/', requireApiKey, handler)   just that route
  └─ handler
```

Auth is just this: a "protected route" is a route with an auth check in its
chain (see `../auth`). If `requireApiKey` responds with a 401 and doesn't call
`next()`, the handler never runs.

An exception thrown anywhere in the chain is caught once, at the top, and
turned into a `500` (try `GET /boom`). That's why one bad handler doesn't crash
the whole server.

## 6. Grouping: sub-routers and prefixes

Real apps have hundreds of routes, so they're grouped by resource:

```js
app.mount('/api/books', booksRouter)      // booksRouter defines '/', '/:id', ...
app.mount('/api/authors', authorsRouter)
```

`booksRouter` doesn't know where it's mounted. `'/:id'` becomes
`'/api/books/:id'` at mount time. That's how you split routes into files, and
how versioning works: mount the same routers under `/api/v1` and
`/api/v2` alongside the changed ones.

## 7. What real routers do differently

- **Speed.** This one checks every route on every request (O(number of routes)).
  Fast routers (find-my-way in Fastify, httprouter in Go) build a **radix
  tree** of segments, so lookup cost depends on the path length, not on how
  many routes exist.
- **More pattern syntax.** Wildcards (`/files/*`), optional segments, regex
  constraints (`/:id(\\d+)`).
- **Case sensitivity, trailing slash, and encoded slashes** are all settings,
  and they differ between frameworks.

The core never changes, though: **(method, path) -> chain of functions.**
