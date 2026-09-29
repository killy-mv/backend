# HTTPS

Everything in `server/` assumed the bytes arrive intact and from who they claim
to be. This folder is about earning that assumption on a hostile network.

## 1. HTTPS is not a protocol

There is no "HTTPS spec". It is **HTTP, unchanged, with TLS slid underneath**:

```
HTTP        GET /users/1 ...      <- identical in both
  |
TLS         encrypt / authenticate   <- the only new layer
  |
TCP         ordered byte stream
```

Your handler code never knows. Same methods, same headers, same status codes.
The `s` is one extra layer in the stack and a different default port (443).

## 2. It buys three things, and only the third is hard

| Guarantee | Means | Without it |
|---|---|---|
| **Confidentiality** | nobody on the path reads the bytes | café wifi reads your password |
| **Integrity** | nobody alters them undetected | ISP injects ads into your page |
| **Authentication** | you're talking to the *real* `bank.com` | everything above is worthless |

Encryption alone is easy and useless. If you don't know *who* holds the other
end of the tunnel, an attacker in the middle simply runs one encrypted
connection to you and another to the real server, reading everything in
between. **Authentication is what makes the encryption mean something**, and
almost all of TLS's complexity lives there.

## 3. Three primitive families (fix this vocabulary first)

The symmetric/asymmetric split applies to **encryption only**. Hashing is
neither — it has no key at all.

| Family | Key situation | Examples | Speed |
|---|---|---|---|
| **Hash** | no key, one-way | SHA-256 | very fast |
| **Symmetric** | one shared key, both directions | AES-GCM, ChaCha20 | fast |
| **Asymmetric** | a *pair*; what one key does, only the other undoes | RSA, ECDSA, ECDHE | slow |

## 4. The handshake does two separate jobs

People blur these together. They are unrelated mechanisms solving unrelated
problems, and both use asymmetric crypto.

**Job 1 — key agreement (ECDHE).** Both sides exchange public values and each
independently *computes* the same shared secret. Nothing secret is ever
transmitted; an eavesdropper who recorded the entire exchange still cannot
derive it. This produces confidentiality.

**Job 2 — authentication (a signature).** The server signs a hash of the
handshake transcript with the private key belonging to its certificate. Only
the real `bank.com` holds that key. This is the step that kills the
man-in-the-middle — an impostor can do a perfectly good key exchange, but
cannot produce that signature.

Rough TLS 1.3 flow (one round trip):

```
client  ->  ClientHello    versions, ciphers, SNI, my DH public value
server  ->  ServerHello    chosen cipher, my DH public value
            Certificate    here is my identity, signed by a CA
            Finished       signature over the transcript + MAC
        <both derive the same keys via HKDF>
client  ->  Finished
        <-- application data, now symmetric -->
```

## 5. Asymmetric only to bootstrap; symmetric for everything after

Public-key crypto is orders of magnitude too slow for bulk data. Its entire
purpose is to safely establish one shared symmetric key — then it retires and
AES-GCM/ChaCha20 carries the actual HTTP traffic. This is why HTTPS costs a
round trip up front but is essentially free per-request afterwards.

**Forward secrecy** falls out of doing it this way. Because the DH values are
ephemeral (that's the `E`), they're discarded when the connection ends. Steal
the server's private key a year later and you *still* cannot decrypt recorded
past sessions.

> Old diagrams show the client encrypting a secret with the server's public key
> (*RSA key transport*). TLS 1.3 removed it precisely because it has no forward
> secrecy — one stolen key retroactively opens every session ever recorded.

## 6. A certificate is a signed claim, and trust is a chain

A certificate is just a document containing:

- a **domain name** (the subject)
- a **public key**
- validity dates
- the **signature of a Certificate Authority** over all of it

It proves nothing on its own — anyone can generate one saying `bank.com`. It
becomes meaningful because a CA signed it, and the CA only signs after making
you prove you control the domain.

```
Root CA         self-signed, key kept offline
  └─ Intermediate CA      signed by root, does day-to-day issuing
      └─ your leaf cert   signed by intermediate
```

The chain terminates at a **root store** — the ~100–150 root certificates your
OS and browser ship with. Trust is not derived; it is *shipped as a list*. That
list is the actual foundation of the whole system, which is also its weakness:
any CA in it can vouch for any domain.

The private key never leaves your server. It is not in the certificate, and the
certificate is public by design.

## 7. What TLS still leaks

Encrypted does not mean invisible. An observer on the path can see:

- the **IP** you connected to
- the **domain**, via SNI in the plaintext ClientHello (Encrypted Client Hello
  fixes this, still rolling out)
- **DNS lookups**, unless you use DoH/DoT
- **sizes and timing** of messages — enough to fingerprint which page you loaded

What they cannot see: URLs, headers, cookies, bodies. Everything after the
request line is inside the tunnel.

## 8. Getting it working — the actual checklist

The certificate is **free**. The domain is the only thing that costs money.

1. **A domain name** (~$10–15/yr). Certs bind to names, not IPs.
2. **DNS A record** pointing at your server — the CA resolves it to verify you.
3. **Ports 80 and 443 open** — on the host firewall *and* the cloud provider's
   security group. Forgetting the second is the classic time sink.
4. **Prove control + get issued**, via an ACME client talking to Let's Encrypt:

   | Challenge | How | When |
   |---|---|---|
   | HTTP-01 | serve a token at `/.well-known/acme-challenge/` | default; needs :80 |
   | DNS-01 | publish a TXT record | wildcards, or no public :80 |
   | TLS-ALPN-01 | special handshake on :443 | :80 unavailable |

5. **Install cert + key** wherever TLS terminates.
6. **Automate renewal.** Certs last 90 days; renew at ~60. Expiry is the single
   most common HTTPS outage — never do this by hand.
7. **Redirect HTTP → HTTPS**, then add `Strict-Transport-Security` (HSTS) so
   browsers refuse plaintext to your domain at all.

Steps 4–6 are free if you put **Caddy** in front — it does ACME automatically
with no cron job. nginx + certbot is the traditional equivalent with more moving
parts; Traefik if you're in Docker/k8s (see `docker/`, `kubernetes/`).

## 9. The four cases, concretely

That checklist is the *full* list. How much of it you actually perform depends
entirely on who owns the machine.

| | Buy domain | Point DNS | Open ports | Get cert | Renew |
|---|---|---|---|---|---|
| **BaaS** | optional | only for custom domain | — | vendor | vendor |
| **PaaS** | yes | yes | — | platform | platform |
| **IaaS** | yes | yes | **you** | **you** | **you** |
| **Self-host** | yes | yes + DDNS | **you + router** | **you** | **you** |

The pattern: you inherit responsibility from the bottom of the stack upward.
TLS work is a direct function of how much infrastructure you own.

### BaaS — nothing to do

Firebase, Supabase, Appwrite hand you HTTPS on their domain
(`xyz.supabase.co`) from the first request. There is no cert to obtain, no port
to open, no renewal to schedule.

The only optional work is a **custom domain**: add a CNAME pointing at the
vendor's target, register the domain in their dashboard, and they issue and
rotate the cert for you.

The trap is thinking this means you're done securing the connection. In BaaS
your client talks to the database *directly*, so TLS protects the pipe while
**authorization is entirely on you** — Firestore security rules, or Postgres
row-level security in Supabase. The anon API key sitting in your frontend is
public by design; those rules are the only thing behind it. A perfect padlock
in front of a world-readable table is still a data breach. See `BaaS/`, `auth/`.

### PaaS — point DNS, click a button

Vercel, Railway, Render, Fly, Cloudflare Pages/Workers:

1. Add the domain in the dashboard.
2. Create the DNS record they specify (usually a CNAME to `*.vercel-dns.com`
   or similar).
3. Wait. They detect the record, run ACME, install the cert, and renew forever.

Two things that actually bite:

- **Apex domains can't be CNAMEs.** Classic DNS forbids `example.com CNAME …`.
  Use your provider's `ALIAS` / `ANAME` / CNAME-flattening record, or the A
  record the platform gives you. Subdomains (`api.example.com`) have no issue.
- **Issuance fails if DNS isn't live yet.** The validation happens against
  public DNS, so propagation delay looks like a broken cert. Re-trigger after
  the record resolves.

Then flip on "force HTTPS" and add HSTS. You will never see a `.pem` file. See
`PaaS/`, `deploy/`.

### IaaS — the whole checklist is yours

EC2, Compute Engine, Oracle Cloud, a DigitalOcean droplet. You own the OS, so
you own TLS. Concretely:

1. A record → the VM's **static** public IP (allocate one; default IPs can
   change on stop/start).
2. Open 443 (and 80) in **two** places: the cloud firewall/security group *and*
   the host firewall (`ufw`, `firewalld`). Missing either produces an identical
   silent timeout — check both before debugging anything else.
3. Install Caddy, point it at your app:

   ```
   api.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   That's the entire config. On start it obtains the cert via ACME and renews
   it indefinitely.
4. **Bind your app to `127.0.0.1`, not `0.0.0.0`.** Otherwise port 3000 stays
   reachable from the internet and anyone can bypass TLS entirely by asking for
   it directly. The reverse proxy is only a security boundary if the thing
   behind it isn't independently exposed.
5. Verify renewal actually works *before* you need it —
   `certbot renew --dry-run`, or confirm Caddy's cert storage is on a persistent
   volume (a container that loses `/data` re-requests certs every restart and
   will hit Let's Encrypt's rate limits).

### Self-host — IaaS plus network problems

A machine in your house or office. Everything above applies, and then the
network fights you:

| Problem | Why | Fix |
|---|---|---|
| Dynamic residential IP | ISP rotates it; your A record goes stale | Dynamic DNS (ddclient, Cloudflare API) |
| ISP blocks inbound :80 | HTTP-01 challenge can't complete | Use **DNS-01** instead |
| Behind NAT | Router doesn't know where to send :443 | Port-forward 80/443 to the box's LAN IP |
| **CGNAT** | You have *no* inbound reachability at all | Tunnel — see below |
| Can't reach own domain from inside LAN | No NAT hairpinning | Split-horizon DNS, or resolve locally |

**CGNAT is the one that stops you cold.** If your ISP shares one public IP
across many customers, no port forward exists to configure. The escape is an
outbound tunnel — **Cloudflare Tunnel** or **Tailscale Funnel** — where your
server dials *out* to their edge and traffic returns through that connection.
TLS then terminates on their edge, and the tunnel itself is the encrypted
origin hop. This also sidesteps DDNS and port forwarding entirely, which is why
it's the default recommendation for home labs now.

For **internal-only** services, note that a real cert still works: buy a domain,
use DNS-01 (which never needs inbound anything), and point `nas.example.com` at
`192.168.1.50`. Public DNS revealing a private IP is harmless. The alternative
— running your own CA and distributing the root to every device — is more work
than the domain costs.

## 10. Where TLS terminates matters

TLS protects **one hop**, not a journey. The moment you add a proxy, you have
two independent connections:

```
browser --TLS--> Cloudflare --???--> your origin server
```

Cloudflare's "Flexible" mode leaves that second leg in **plaintext** while the
browser still shows a padlock. Use **Full (strict)** so the origin hop is
encrypted *and* its certificate verified. Same reasoning applies to a load
balancer in front of app servers (`scaling-server/`): terminating at the edge
means the internal hop is your responsibility.

## 11. Localhost is a different problem

No CA will certify `localhost` — there's no public name to validate. Use
**mkcert**: it creates a local CA, installs it into your OS/browser trust store,
and issues certs your machine trusts.

A raw self-signed cert gives the scary browser warning, and that warning is the
system working correctly — nothing in the root store vouches for it. Clicking
through it in dev is fine; wiring `rejectUnauthorized: false` into application
code is how that habit turns into a production vulnerability.

## The one-sentence version

> TLS uses slow public-key crypto exactly once — to agree on a shared secret and
> to prove, via a CA-signed certificate, who you agreed with — then hands the
> connection to fast symmetric crypto for the rest of its life.

## The layers, bottom to top

```
kernel: TCP/IP, port 443
  └─ TLS record layer: encrypt / MAC every chunk
      └─ TLS handshake: key agreement + certificate verification
          └─ HTTP parser: bytes -> method, path, headers, body
              └─ router -> middleware -> handler
```

Compare with the stack in `server/` — TLS is one insertion, and everything above
it is unchanged.
