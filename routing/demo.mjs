// Fires a batch of requests at the server and shows the routing decision for
// each. Starts its own copy of the server on a random port, so just run:
//   node demo.mjs

import { server } from './server.mjs'

await new Promise((resolve) => server.listen(0, resolve))
const base = `http://localhost:${server.address().port}`

const cases = [
  ['static route', 'GET', '/health'],
  ['path parameter -> req.params.id', 'GET', '/api/books/3'],
  ['static beats :id, despite registration order', 'GET', '/api/books/featured'],
  ['query string is not part of the match', 'GET', '/api/books?author=2&sort=year'],
  ['trailing slash is ignored', 'GET', '/api/books/'],
  ['two params in one path', 'GET', '/api/authors/1/books/2'],
  ['route matched, handler says the book is missing', 'GET', '/api/books/99'],
  ['no pattern matches the path -> 404', 'GET', '/api/movies'],
  ['path exists, method does not -> 405', 'PUT', '/api/books/3'],
  ['route-level middleware blocks it', 'POST', '/api/books', { title: 'Mort', authorId: '2' }],
  ['same route with the API key', 'POST', '/api/books', { title: 'Mort', authorId: '2' }, { 'x-api-key': 'demo' }],
  ['same path, different method, different handler', 'DELETE', '/api/books/5', null, { 'x-api-key': 'demo' }],
  ['HEAD is answered by the GET route', 'HEAD', '/api/books/1'],
  ['a crashing handler becomes a 500', 'GET', '/boom'],
]

console.log('\n--- server log ---')
const rows = []
for (const [why, method, path, body, headers = {}] of cases) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body && { 'content-type': 'application/json' }), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  await res.arrayBuffer() // drain the body
  const route = res.headers.get('x-matched-route') ?? '-'
  const allow = res.headers.get('allow')
  rows.push(`${method.padEnd(6)} ${path.padEnd(32)} ${res.status}  ${route.padEnd(40)} ${why}${allow ? ` (Allow: ${allow})` : ''}`)
}

console.log('\n--- what the router decided ---')
console.log(`${'METHOD'.padEnd(6)} ${'PATH'.padEnd(32)} CODE ${'MATCHED ROUTE'.padEnd(40)} WHY`)
console.log(rows.join('\n'))

server.close()
