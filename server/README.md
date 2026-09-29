# Server — Core Mental Model

The foundation everything else in this repo sits on. When a later topic (auth,
caching, scaling) gets confusing, come back here and ask "where does this fit in
the accept loop?"

## 1. A server is a process, not a machine

The biggest correction to intuition: a server is a program that is **already
running before anyone visits**. It does not start up when a request arrives.

It's a loop that never exits, blocked waiting for input — the same shape as a CLI
waiting on stdin, except the input arrives over the network.

"Server" as a *box in a rack* is a different meaning of the word. In backend
work, it means the process.

## 2. The port is an OS address, not something you own

The OS owns the network card. Your process asks the kernel:

> "Route anything arriving on port 3000 to me."

That's `listen()`. A port is just a 16-bit number the kernel uses to demultiplex
incoming packets to the right process. Only one listener per (address, port) —
which is why `EADDRINUSE` / "port already in use" exists.

## 3. The accept loop is the whole thing

Every server ever written, in every language, under every framework, is this:

```
socket()            // ask the OS for a network endpoint
bind(port)          // claim an address
listen()            // tell the OS to queue incoming connections
loop {
    conn = accept()      // blocks until someone connects
    bytes = read(conn)
    result = do_work(bytes)
    write(conn, result)
    close(conn)
}
```

Express, Spring, Django, Rails, nginx — all decoration on that loop. They add
parsing, routing, and concurrency, but none of them replace it.

## 4. TCP gives you bytes; HTTP gives you meaning

TCP is an **ordered stream of bytes** with no concept of where one message ends
and the next begins. It will happily hand you half a request, or two requests
glued together.

HTTP is a *convention* layered on top to solve that framing problem:

```
GET /users/1 HTTP/1.1      <- request line
Host: example.com          <- headers
Content-Length: 0
                           <- blank line = end of headers
<body, exactly Content-Length bytes>
```

That's why every framework ships a parser, and why framing bugs (request
smuggling, chunked-encoding mismatches) are a real class of vulnerability.

**Protocol = an agreement about framing and meaning.**

## 5. The server has no memory between requests

Request N and request N+1 are unrelated unless you *deliberately* connect them.
Anything stashed in a process variable is a trap: it dies on restart and isn't
shared once you run two copies of the process.

So state lives in exactly three places:

| Where | Examples | Trade-off |
|---|---|---|
| The client | cookie, JWT, localStorage | Free to scale, but untrusted — must be verified |
| A shared store | Postgres, Redis | Trusted and shared, but a network hop and a new failure mode |
| Nowhere | recomputed per request | Simplest, costs CPU |

This constraint is **why horizontal scaling works at all**. Internalize it now
and auth, caching, and scaling stop feeling like separate topics.

## 6. Concurrency: what you do while waiting

The defining question for a server is not "how fast does it compute" but:

> What happens to request #2 while request #1 is waiting on the database?

Almost all server time is **waiting on something else** — DB, disk, another API
— not CPU work. The models differ only in what they spend to keep waiting:

| Model | Unit per request | Cost | Examples |
|---|---|---|---|
| Process per request | `fork()` | Very heavy | old CGI |
| Thread per request | OS thread (~1MB stack) | Heavy | Java servlets, Apache |
| Event loop | a callback on one thread | Very cheap | Node.js, nginx |
| Green threads | runtime-scheduled thread (~KBs) | Cheap | Go, Erlang |

Node being "single-threaded" only makes sense through this lens: it cannot do
two *computations* at once, but it can be waiting on 10,000 sockets at once.
Corollary: CPU-heavy work blocks an event-loop server in a way it wouldn't block
a thread-per-request server.

## 7. Your handler is a mediator, not a doer

In practice, nearly every handler is:

```
parse → validate → call something else (DB / cache / another service) → shape response
```

The server owns **policy and plumbing**; the actual data lives elsewhere.
Keeping this in view is what stops business logic from leaking into the wrong
layer.

## 8. It is a public surface under hostile conditions

Unlike a script you run yourself, a server is reachable by strangers at
arbitrary rates and must stay up through failures it didn't cause. That produces
the permanent set of concerns:

- **Validate every input** — every byte arrives from someone you don't trust.
- **Timeout every outbound call** — a hung dependency otherwise consumes all
  your capacity.
- **Expect the client to vanish** mid-response.
- **Expect dependencies to be down**, not just slow.
- **Make retries safe** (idempotency) — the network guarantees you nothing about
  whether your response arrived.

## The one-sentence version

> A server is a long-lived process that owns a port, loops forever accepting
> connections, translates bytes into requests, delegates state to other systems,
> writes bytes back — and manages what it does while waiting.

## The layers, bottom to top

```
network card
  └─ kernel: TCP/IP, ports, connection queue
      └─ socket: accept() / read() / write()
          └─ HTTP parser: bytes -> method, path, headers, body
              └─ router: path -> handler
                  └─ middleware: auth, logging, CORS
                      └─ handler: your logic
                          └─ data layer: DB, cache, other services
```

Each folder in this repo plugs into one of these layers.
