# Auth

`../server` §5: the server has no memory between requests. `../client` §5–6:
the client is where continuity lives, and the client is a stranger. Auth is
what you get when you put those two facts together: **every request must carry
its own proof of identity, and the server must verify that proof every time.**

## Run the examples

One folder per scheme, each a tiny Express server plus a page that shows
exactly what goes over the wire. No auth libraries — cookies and JWT signing
are written by hand so nothing is hidden.

```
auth/
├── credentials.txt      demo users (ada/secret = admin, alan/enigma, grace/cobol)
├── users.mjs            the "users table": hashes those at startup (scrypt)
├── basic/   server/ src/    -> http://localhost:3001
├── session/ server/ src/    -> http://localhost:3002
└── jwt/     server/ src/    -> http://localhost:3003
```

```bash
cd basic/server && npm install && npm start     # same for session/ and jwt/
```

What each page lets you see:

| Demo | Try this |
|---|---|
| basic | every click re-runs the ~30ms password hash (server log); open `/api/me` as a link to get the browser's popup — then find there's no way to log out |
| session | `document.cookie` is empty while logged in (`HttpOnly`); inspect the server-side store; revoke a user and they're out on the next click |
| jwt | watch the token decode without the secret and count down to expiry; tamper with the role or forge `alg: none` and get rejected; log out and reuse the old token — it still works |

## 1. Two questions, not one

| | Question | Fails with |
|---|---|---|
| **Authentication** (authn) | *Who* are you? | `401 Unauthorized` — "I don't know who you are" |
| **Authorization** (authz) | *What* are you allowed to do? | `403 Forbidden` — "I know who you are, and no" |

(Yes, `401` is misnamed — it means *unauthenticated*.)

Authentication produces an identity. Authorization is a rule applied to that
identity: `user.role === 'admin'`, `post.authorId === user.id`. Everything
below is about authentication — getting a trustworthy identity onto every
request. Authorization is ordinary code that runs after it.

Identity isn't only for locking doors. The same mechanism powers "welcome back,
Ada", a remembered cart, a language preference. Even anonymous visitors often
get a session — it just isn't tied to a user yet.

## 2. The core move: trade an expensive credential for a cheap one

Sending the password on every request works (that's Basic auth, §4), but it
means the most valuable secret travels constantly and the server re-runs a
deliberately slow password check each time. So nearly every scheme does this:

```
client                                   server
  |-- POST /login {user, password} ------>|  verify password (slow, once)
  |<------------------ credential --------|  issue something cheaper to check
  |                                       |
  |-- GET /orders  + credential --------->|  verify credential (fast, every time)
  |-- GET /profile + credential --------->|  verify credential
```

"Logging in" is just this exchange. "Logging out" is making the cheap credential
stop working. The schemes differ only in **what that credential is**.

## 3. Two independent axes

The common framing "Basic vs sessions vs cookies vs JWT" mixes two separate
decisions:

**Axis A — what the credential is (where the state lives):**

| Credential | Contains | Server must look it up? |
|---|---|---|
| Password | the secret itself | yes — against the password hash |
| Session id | a random, meaningless string | yes — in the session store |
| JWT | the identity itself, signed | no — just checks the signature |

**Axis B — how it travels:**

| Transport | Sent by | Header |
|---|---|---|
| Cookie | the browser, **automatically** on every matching request | `Cookie: sid=...` |
| Authorization header | **your code**, explicitly, every time | `Authorization: Bearer ...` |

Any A can ride any B. Session id in a cookie is the classic web app. JWT in an
`Authorization` header is the classic mobile/API client. JWT *in a cookie* is
common too. So "cookies vs JWT" is not a real choice — one is a transport, the
other is a format. The real choice on axis A is **where the state lives**,
which is `../server` §5's table again:

- Session → state in a **shared store**, client holds only a pointer.
- JWT → state **in the client**, signed so it can't be tampered with.

## 4. Basic auth — no exchange at all

The client sends username and password on **every** request:

```
Authorization: Basic YWRhOnNlY3JldA==      <- base64("ada:secret")
```

Base64 is **encoding, not encryption** — anyone who sees the header has the
password. Only acceptable over HTTPS.

- ✅ Dead simple, built into every HTTP client and browser (the grey popup).
- ❌ No logout (the browser caches it), password on the wire constantly, slow
  hash check per request, no nice login page.
- Used for: internal tools, quick protection of a staging site, machine-to-machine
  calls where the "password" is really an API key.

## 5. Sessions — the server remembers, the client holds a ticket

```
POST /login          -> verify password
                     -> sid = random 128+ bits
                     -> store  sessions[sid] = { userId: 1, expires: ... }
                     <- Set-Cookie: sid=9f8a...; HttpOnly; Secure; SameSite=Lax

GET /orders          -> Cookie: sid=9f8a...        (browser adds it automatically)
                     -> sessions[sid] -> userId 1 -> handle request
POST /logout         -> delete sessions[sid]       (instantly dead everywhere)
```

The session id means nothing by itself — it's a coat-check ticket. All the
truth is on the server.

- ✅ **Instant revocation**: delete the row, the user is logged out. Ban a user,
  change their role — takes effect on the next request.
- ✅ Tiny cookie, nothing sensitive leaves the server.
- ❌ A lookup on every request.
- ❌ The store must be **shared**. Keep sessions in process memory (like
  `users` in `../server/express/server.js`) and they vanish on restart and
  don't exist on the second copy of the server. Real deployments use Redis or
  the database.

## 6. JWT — the client carries the truth, signed

A JWT is three base64url chunks joined by dots:

```
eyJhbGciOiJIUzI1NiJ9 . eyJzdWIiOjEsInJvbGUiOiJhZG1pbiIsImV4cCI6...  . 4pP3x...
       header                          payload (claims)                      signature
  {"alg":"HS256"}       {"sub":1,"role":"admin","exp":1759150000}   HMAC(header.payload, SERVER_SECRET)
```

To verify, the server recomputes the signature with its secret and compares.
If anyone edited the payload (`"role":"user"` → `"admin"`), the signature no
longer matches. **No lookup needed** — the token *is* the session.

Two things people get wrong:

- **Signed ≠ encrypted.** The payload is plain base64 — anyone can read it.
  Never put secrets in it.
- **Always check `exp` and pin the algorithm.** Libraries have shipped bugs
  accepting `"alg":"none"`; configure the verifier to accept only what you sign
  with.

Trade-offs:

- ✅ Stateless verification — any server with the key can check it, no shared
  store, works across services.
- ❌ **Can't be revoked.** A stolen or outdated token (user banned, role changed)
  stays valid until `exp`. The server has nowhere to "delete" it.

The standard patch for revocation:

```
access token   JWT, short-lived (~5–15 min), sent on every request, never looked up
refresh token  long-lived, stored server-side, used only to get new access tokens
```

Revoke the refresh token and the user is out within one access-token lifetime.
Notice what happened: to get logout back, **state came back** — the refresh
token is a session. Pure statelessness and instant revocation are mutually
exclusive; every design picks a point between them.

## 7. Side by side

| | Basic | Session | JWT |
|---|---|---|---|
| Credential on each request | password | random id | signed claims |
| State lives | password DB | session store | inside the token |
| Per-request cost | slow hash check | store lookup | signature check (CPU only) |
| Logout / revoke | impossible (browser caches it) | instant | wait for `exp` (or add state back) |
| Scaling concern | none | store must be shared | key must be shared |
| Natural fit | scripts, internal tools | browser apps, one backend | APIs, mobile, many services |

Reasonable default for a browser app with one backend: **session id in an
`HttpOnly` cookie.** Reach for JWTs when multiple independent services need to
verify identity without calling a central store.

## 8. The transport choice is a security choice

Where the credential lives decides which attack you have to defend against:

| Stored in | Sent by | Main threat | Defense |
|---|---|---|---|
| Cookie | browser, automatically | **CSRF** — another site triggers a request, the browser attaches your cookie | `SameSite=Lax/Strict`, CSRF tokens |
| `localStorage` + header | your JS | **XSS** — any injected script can read and exfiltrate it | don't have XSS (hard); prefer `HttpOnly` cookies |

The cookie flags that matter:

```
Set-Cookie: sid=9f8a...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400
            │            │         │       │
            │            │         │       └─ not sent on most cross-site requests (CSRF)
            │            │         └─ only over HTTPS
            │            └─ invisible to JavaScript (XSS can't steal it)
            └─ the credential
```

Automatic sending is both the cookie's convenience and its danger. Explicit
headers can't be forged cross-site, but they need JS to hold the token — which
is exactly what XSS steals. Non-browser clients (`../client` §8) have no
cookie jar by default, so they almost always use the header.

## 9. Rules that hold regardless of scheme

- **HTTPS always** (`../https`). Every credential above is a bearer token —
  whoever holds it *is* the user. On plain HTTP, anyone on the path can take it.
- **Never store passwords — store slow hashes.** `argon2` or `bcrypt`, never
  plain SHA-256. Slowness is the point: it makes stolen-database cracking
  expensive.
- **Verify on every request, server-side.** The client's "I'm logged in as
  admin" UI state is a suggestion (`../client` §5). A hidden button is not
  authorization.
- **Authorize per resource, not just per route.** "Is logged in" isn't enough
  for `GET /orders/42` — check that order 42 belongs to *this* user. Skipping
  this (IDOR) is one of the most common real-world bugs.
- **Same error for "no such user" and "wrong password"** — otherwise login
  becomes a user-enumeration oracle.
- **Rate-limit login.** It's the one endpoint built to accept guesses.

## Beyond this note

The same two ideas — exchange a strong credential for a cheap one, and decide
where state lives — underlie everything else you'll meet:

| Term | Really is |
|---|---|
| API key | a long-lived password for a machine, usually in a header |
| OAuth 2.0 | a protocol for one service to get a token to act on your behalf at another |
| OpenID Connect | OAuth + a JWT (the ID token) saying who you are — "Sign in with Google" |
| MFA / passkeys | stronger ways to do the *expensive* step at login; the session afterwards is the same |

## The one-sentence version

> Because the server forgets everything between requests, the client must
> present proof of identity every time; you log in once with an expensive
> credential to obtain a cheap one, and the only real design choice is whether
> that cheap credential is a pointer to state on the server (session — easy to
> revoke) or the state itself, signed (JWT — easy to scale).

## Do it by hand

Basic auth is just base64 — no crypto:

```bash
echo -n 'ada:secret' | base64            # YWRhOnNlY3JldA==
echo 'YWRhOnNlY3JldA==' | base64 -d      # ada:secret   <- why HTTPS is mandatory
curl -v -u ada:secret localhost:3001/api/me       # watch curl add the header
curl -u alan:enigma localhost:3001/api/admin      # 403: known, but not allowed
```

Cookies are just headers that curl can save and replay — the same thing the
browser does for you:

```bash
curl -i -c jar.txt -H 'Content-Type: application/json' \
     -d '{"username":"alan","password":"enigma"}' localhost:3002/api/auth/login
curl -b jar.txt localhost:3002/api/me            # the cookie is the only credential
curl localhost:3002/api/debug/sessions           # ...and here's what it points at
```

A JWT payload is readable by anyone (signed ≠ encrypted):

```bash
TOKEN=$(curl -s -H 'Content-Type: application/json' \
     -d '{"username":"alan","password":"enigma"}' localhost:3003/api/auth/login \
     | sed 's/.*"accessToken":"\([^"]*\)".*/\1/')
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null; echo    # {"sub":"alan","role":"user",...}
curl -H "Authorization: Bearer $TOKEN" localhost:3003/api/me
```

## Where this plugs in

In `../server`'s layer stack, authentication is **middleware** — it runs before
every handler and turns a credential into `req.user`. Authorization lives in
the handler, because only the handler knows which resource is being touched:

```
HTTP parser
  └─ router
      └─ middleware: read cookie / Authorization header
                     -> verify (session lookup or JWT signature)
                     -> req.user = { id, role }   or 401
          └─ handler: may req.user touch THIS resource?  -> 403 or proceed
              └─ data layer: users table (password hashes), session store
```
