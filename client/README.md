# Client 

The other end of the conversation from `../server`. Read that one first: this
note is mostly a set of consequences of the fact that the server is a process
sitting blocked in `accept()`, waiting for someone to speak.

## 1. Client = the one who initiates

A client is a process that **opens a connection and speaks first**. That is the
entire definition. Not "the one with a UI", not "the pretty one", not "the
browser".

```
client                          server
  |                               | (already running, blocked in accept())
  |-- connect ------------------->| accept() returns
  |-- request bytes ------------->| read()
  |                               | do_work()
  |<------------- response bytes -| write()
  |                               |
```

Initiator vs. responder. Everything else in this file falls out of that one
asymmetry.

## 2. The roles are relative, and they stack

The same process is a server to the thing above it and a client to the thing
below it — often within a single request:

```
browser ──client──> nginx ──client──> express ──client──> Postgres
```

Express is a *server* to the browser and a *client* of the database at the same
time. So "client" and "server" are labels on a **connection**, not properties of
a program.

Once this clicks, proxies, caches, microservices and API gateways stop being new
concepts — they're the same two roles, chained.

## 3. The server cannot call the client

The most consequential fact here. The server only holds a socket that someone
else opened; it has no way to start a conversation. Every "push" mechanism is a
workaround for this:

| Mechanism | How it dodges the rule |
|---|---|
| Polling | client asks over and over |
| Long polling | client asks, server holds the response open until there's news |
| SSE | client opens once, server streams down that same connection |
| WebSocket | client opens once, upgraded to full duplex |
| Webhook | the "client" runs its own server, so the roles flip |

A webhook is not an exception — it's a role swap. Your server becomes a client
of their server.

## 4. The contract is the only thing they share

The two sides know nothing about each other except the protocol and the API:
method, path, headers, body shape, status codes. Everything behind that line is
private and free to change.

That's why you can swap Express for Go, or a React app for a mobile app, without
the other side noticing — as long as the contract holds.

The flip side: **your API is a public promise**. You can't refactor it the way
you refactor an internal function, because clients you don't control (and can't
redeploy) are holding you to it.

## 5. The client is untrusted — always

The server never sees "my form". It sees bytes from a stranger:

```bash
curl -X POST localhost:3000/users -d '{"role":"admin"}'   # no form, no JS, no validation
```

Anything the client does is a *suggestion*. So:

- Client-side validation is **UX** — fast feedback, fewer round trips.
- Server-side validation is **security** — the only place a rule is actually
  enforced.

Corollary: your UI is just one possible client. `curl`, a script, a competitor's
scraper and a hostile bot are equally valid clients of the same endpoint. Design
the API as if the browser doesn't exist.

## 6. The client is where continuity lives

`../server` §5: the server has no memory between requests. The client does —
cookie, JWT, `localStorage`, a session id. So the client is the thing that makes
request N+1 recognizably related to request N.

Which is exactly why that state has to be **signed or verified** on arrival:
you are trusting a stranger to carry your identity token around and hand it back
unmodified. Cookies and JWTs are shaped the way they are because of this
distrust, not because of tradition.

## 7. Between them sits a network that lies

Neither side can distinguish "request lost", "server crashed" and "response
lost". They look identical from the client. That single ambiguity generates most
of the operational rules on both ends:

| Side | Must handle |
|---|---|
| Client | timeouts, retries, backoff, partial/garbage responses |
| Server | idempotency (a retry must not double-charge), client vanishing mid-response |

Retry safety is a *shared* concern: the client decides to retry, but only the
server can make it harmless.

## 8. Clients are not all browsers

Worth listing, because "client == browser" is the intuition that has to go:

| Client | Notes |
|---|---|
| Browser | cookies, CORS, same-origin policy — a very opinionated client |
| Mobile app | no cookie jar by default, long-lived tokens, bad networks |
| `curl` / `nc` | no rules at all — the honest baseline |
| Another server | service-to-service; no user sitting there to retry by hand |
| CLI / SDK | a library that hides the socket from you |

The browser is the *least* typical client, not the default one. It's the only
one with a security model imposed on it from outside.

## 9. The browser is two clients, and the app decides which one talks

Inside one browser tab there are two different requesters:

| Requester | Triggered by | Expects | What happens to the response |
|---|---|---|---|
| **Navigation** | address bar, `<a href>`, `<form>` submit | HTML (`Accept: text/html`) | whole page is thrown away and replaced |
| **JavaScript** | `fetch()` / XHR in the page's code | anything — usually JSON | handed to the JS; the page stays alive |

A "rendering strategy" is just a decision about **where and when data becomes
HTML** — and that decides which of the two requesters does most of the talking:

| Model | HTML is built... | On a click, the wire carries |
|---|---|---|
| **Static (SSG)** | once, at build time, on the build machine | a pre-made `.html` file from disk / CDN |
| **MPA / SSR** | per request, on the server | a full, freshly rendered HTML document |
| **SPA (CSR)** | in the browser, by JS | JSON — the HTML shell was sent only once |
| **Hybrid** (Next, Nuxt, Remix) | server on first load, browser after | HTML first, then JSON / framework payloads |
| **HTML-over-the-wire** (htmx, Turbo) | per request, on the server | an HTML *fragment*, swapped in by a little JS |

Two common mix-ups:

- **Static ≠ SSR** — they're opposites on the *when* axis. Static renders once
  for everyone; SSR renders per request (so it can be personalized, and costs
  CPU every time). Both answer a click with HTML.
- **Static vs SPA is not a choice** — they're different axes. "Static" is how
  the *server* serves files; "SPA" is how the *client* behaves. A React SPA is
  typically deployed *as* static files plus a separate JSON API.

What this changes on the server side:

| | Serves an MPA / SSR | Serves an SPA |
|---|---|---|
| Routes return | rendered templates | JSON; one `index.html` for every page path |
| Errors | an error *page* | a status code + JSON body the JS must handle |
| After a form POST | redirect (Post/Redirect/Get), so refresh doesn't resubmit | return the created object; JS updates the screen |
| Auth | session cookie, sent automatically | cookie or `Authorization: Bearer` set by the JS |
| Cross-origin | rarely an issue | CORS, if the API lives on another origin |
| SEO / first paint | content is in the first response | empty shell until the JS runs and fetches |

Consistent with §4: the *server* doesn't know or care which model you picked —
it just answers requests. The same backend can serve HTML to navigations and
JSON to `fetch()`, even on the same path, by looking at the `Accept` header
(content negotiation).

See the difference yourself:

```bash
curl https://some-spa.example        # <div id="root"></div> + a <script> tag — no content
curl https://some-ssr-site.example   # the actual text of the page
```

`curl` doesn't run JavaScript, so it sees exactly what a navigation sees before
any client-side code gets a chance to run.

## The one-sentence version

> A client is a process that opens a connection and speaks first; a server waits
> and answers — and nearly every hard backend problem (auth, sessions, push,
> retries, versioning) comes from the fact that only one side can start the
> conversation, and neither side can trust the other.

## Be the client, by hand

The fastest way to kill the "client == frontend" intuition is to become one:

```bash
# with the express server running
curl -v http://localhost:3000/            # you are the client

# no client library at all — just bytes on a socket
printf 'GET / HTTP/1.1\r\nHost: x\r\n\r\n' | nc localhost 3000
```

The second one is the whole relationship with nothing on top: you opened the
connection, you spoke first, the server answered, someone closed it.

## Where this plugs in

Reading `../server`'s layer stack from the other direction — the client builds
the request going *down*, the server parses it going *up*:

```
your code (fetch / curl / SDK)      <- decides method, path, body
  └─ HTTP serializer: request -> bytes
      └─ socket: connect() / write() / read()
          └─ kernel: TCP/IP, ephemeral port, DNS
              └─ network card
                        ~ the wire ~
                                     network card
                                       └─ kernel: port 3000 -> the listening process
                                           └─ ... (see ../server)
```

Same layers, mirrored. The wire in the middle is the trust boundary.
