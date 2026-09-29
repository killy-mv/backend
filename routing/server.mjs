// A small books API wired up with the hand-written router in router.mjs.
// Watch the server log: every request prints which route (if any) it hit.

import http from 'node:http'
import { Router, json } from './router.mjs'

const PORT = Number(process.env.PORT ?? 3004)
const API_KEY = 'demo'

// --- in-memory "database" ---------------------------------------------------

const authors = [
  { id: '1', name: 'Ursula K. Le Guin' },
  { id: '2', name: 'Terry Pratchett' },
]
const books = [
  { id: '1', title: 'A Wizard of Earthsea', authorId: '1', year: 1968, featured: true },
  { id: '2', title: 'The Dispossessed', authorId: '1', year: 1974, featured: false },
  { id: '3', title: 'Guards! Guards!', authorId: '2', year: 1989, featured: true },
  { id: '4', title: 'Small Gods', authorId: '2', year: 1992, featured: false },
]
let nextId = 5

// --- middleware ---------------------------------------------------------------

// Global: runs for every request, before routing, including ones that 404.
function logger(req, res, next) {
  const start = performance.now()
  res.on('finish', () => {
    const ms = (performance.now() - start).toFixed(1)
    const route = req.route ?? '(no route)'
    console.log(`${req.method.padEnd(6)} ${req.url.padEnd(34)} ${res.statusCode}  -> ${route}  ${ms}ms`)
  })
  return next()
}

// Global: turn a JSON request body into req.body.
async function jsonBody(req, res, next) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next()
  let raw = ''
  for await (const chunk of req) raw += chunk
  try {
    req.body = raw ? JSON.parse(raw) : {}
  } catch {
    return json(res, 400, { error: 'body is not valid JSON' })
  }
  return next()
}

// Route-level: attached only to the routes that change data.
function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) {
    return json(res, 401, { error: `send header "x-api-key: ${API_KEY}"` })
  }
  return next()
}

// Router-level: runs for every route of the router it's use()d on.
function stampApiVersion(req, res, next) {
  res.setHeader('X-API-Version', '1')
  return next()
}

// --- /books -------------------------------------------------------------------

const booksRouter = new Router()
booksRouter.use(stampApiVersion)

// Query parameters don't take part in matching; they arrive as req.query.
// GET /api/books?author=2&sort=year&limit=1
booksRouter.get('/', (req, res) => {
  let result = [...books]
  if (req.query.author) result = result.filter((b) => b.authorId === req.query.author)
  if (req.query.sort === 'year') result.sort((a, b) => a.year - b.year)
  if (req.query.sort === 'title') result.sort((a, b) => a.title.localeCompare(b.title))
  if (req.query.limit) result = result.slice(0, Number(req.query.limit))
  json(res, 200, { query: req.query, count: result.length, books: result })
})

// Registered BEFORE /featured on purpose. A naive first-match router would
// send /books/featured here with id = "featured". Ours picks the static route.
booksRouter.get('/:id', (req, res) => {
  const book = books.find((b) => b.id === req.params.id)
  if (!book) return json(res, 404, { error: `no book with id ${req.params.id}`, params: req.params })
  json(res, 200, { params: req.params, book })
})

booksRouter.get('/featured', (req, res) => {
  json(res, 200, { books: books.filter((b) => b.featured) })
})

booksRouter.post('/', requireApiKey, (req, res) => {
  const { title, authorId, year } = req.body
  if (!title || !authorId) return json(res, 400, { error: 'title and authorId are required' })
  const book = { id: String(nextId++), title, authorId: String(authorId), year, featured: false }
  books.push(book)
  res.setHeader('Location', `/api/books/${book.id}`)
  json(res, 201, { book })
})

booksRouter.patch('/:id', requireApiKey, (req, res) => {
  const book = books.find((b) => b.id === req.params.id)
  if (!book) return json(res, 404, { error: `no book with id ${req.params.id}` })
  Object.assign(book, req.body, { id: book.id }) // the id comes from the URL, never the body
  json(res, 200, { book })
})

booksRouter.delete('/:id', requireApiKey, (req, res) => {
  const index = books.findIndex((b) => b.id === req.params.id)
  if (index === -1) return json(res, 404, { error: `no book with id ${req.params.id}` })
  books.splice(index, 1)
  res.statusCode = 204
  res.end()
})

// --- /authors: nested resources, two params in one path ----------------------

const authorsRouter = new Router()
authorsRouter.use(stampApiVersion)

authorsRouter.get('/', (req, res) => json(res, 200, { authors }))

authorsRouter.get('/:authorId', (req, res) => {
  const author = authors.find((a) => a.id === req.params.authorId)
  if (!author) return json(res, 404, { error: `no author with id ${req.params.authorId}` })
  json(res, 200, { params: req.params, author })
})

authorsRouter.get('/:authorId/books/:bookId', (req, res) => {
  const book = books.find((b) => b.id === req.params.bookId && b.authorId === req.params.authorId)
  if (!book) return json(res, 404, { error: 'no such book by that author', params: req.params })
  json(res, 200, { params: req.params, book })
})

// --- the app: global middleware, top-level routes, mounted sub-routers ---------

const app = new Router()
app.use(logger)
app.use(jsonBody)

app.get('/', (req, res) => json(res, 200, { message: 'routing demo', routes: app.table() }))
app.get('/health', (req, res) => json(res, 200, { ok: true }))
app.get('/boom', () => {
  throw new Error('a handler crashed')
})

app.mount('/api/books', booksRouter)
app.mount('/api/authors', authorsRouter)

export const server = http.createServer(app.handler())

if (import.meta.main) {
  server.listen(PORT, () => {
    console.log(`routing demo on http://localhost:${PORT}\n`)
    console.log(app.table().join('\n') + '\n')
  })
}
