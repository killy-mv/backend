# Database — Core Mental Model 

Picks up directly from `server/README.md` §5: the server has no memory between
requests, so state lives elsewhere. A database is the second row of that table —
the **shared, trusted store**. Every feature below falls out of those two words.

- **Shared** → many processes touch the same data at the same moment.
  Everything about transactions, locks and isolation exists because of this.
- **Trusted** → it is the thing you have designated as allowed to be believed.
  Which means it must survive a power cut mid-write. Hence the log and `fsync`.

Storing bytes is the easy part. Finding them again fast, while other people are
also writing, without ever losing an acknowledged write — that's the job.

## 1. Start from a file, then watch it fail

Every part of a database is a fix for a specific thing that breaks. Store one
JSON object per line in `users.txt`. It works. Then:

| What you ask for | What breaks | The fix |
|---|---|---|
| "Find user #47,000" | Read the whole file. O(n), and n only grows | **Index** |
| Two requests write at once | Appends interleave, records shred each other | **Concurrency control** |
| Power dies mid-write | Half a record on disk, no way to tell | **Atomicity + durability** |
| The file is 400GB | Can't load it into RAM to work with it | **Pages + buffer pool** |
| A new question | Hand-write traversal code, tune it yourself | **Query language + planner** |

A database is that stack of fixes, in one process, done properly. Nothing more
mystical than that.

Note the first one already contains the central trade: an index must be updated
on every write. **Reads get faster, writes get slower. There is no free index.**

## 2. A set of files, plus the only process allowed to touch them

A database is a program. In dev it's a process on your laptop listening on 5432;
in production it's usually a different machine. Same correction as `server`
§1 — it's a *process*, not a location — which is why your app opens a TCP
connection either way, and why "the DB is a network hop" is a cost you always
pay.

But the program is not the data. Kill Postgres and your data is fine, sitting in
files on disk. The process is a **gatekeeper** standing in front of those files.
Nobody touches them directly; you ask the gatekeeper, and the gatekeeper is what
enforces the guarantees. Remove it and the files are just bytes.

> A database = a set of files + a process that is the only thing permitted to
> touch them.

Not every database is a separate process, though:

| | Client–server | Embedded |
|---|---|---|
| Examples | Postgres, MySQL, MongoDB | SQLite, DuckDB |
| Shape | separate process, own port | a library linked into yours |
| Access | many clients over TCP | one process, direct file access |
| Cost | network hop, connections to pool | a function call |

Notice which problem the client–server ones exist to solve: **many** clients. If
your data has exactly one reader/writer, you don't need the server part at all.

## 3. The page is the atom

Disks and SSDs don't do bytes, they do blocks. So a database never reads "a row"
— it reads a fixed-size **page** (8KB in Postgres) that happens to contain that
row. Tables are pages, indexes are pages, and the **buffer pool** is a big
in-RAM cache of hot pages.

This single fact explains a lot of later behaviour:

- Wide rows hurt, because you pay per page fetched, not per column used.
- Sequential scans are far less terrible than they sound — one read yields
  hundreds of rows.
- **Random I/O is the enemy**, not I/O volume. That's the whole reason §5 works.

## 4. You declare the *what*; the planner picks the *how*

The biggest mental break from normal programming: a SQL query contains no loops.
You state the shape of the answer, and a cost-based **optimizer** decides whether
to scan or use an index, which table to drive a join from, and which join
algorithm to use — based on *statistics* it maintains about your data.

Consequences:

- The same query can be fast today and slow next month, because the data changed
  and the plan changed with it.
- Performance is a **negotiation** with the planner, not something you write.
- `EXPLAIN` is how you hear the planner's side of the conversation.

## 5. The log is the truth; the data files trail behind

To make a change durable you'd think you must write the modified page to disk.
But that page lives at a random offset — slow — and a crash halfway through
leaves it corrupt.

So instead: **append a description of the change to a sequential log, `fsync`
that, and only then report success.** The real pages get updated later, lazily.
Crash? Replay the log.

That's the **write-ahead log (WAL)**, and it's the highest-leverage idea in
database internals, because it answers three questions at once:

- **Durability** — sequential append + fsync is cheap enough to do per commit.
- **Atomicity** — a transaction isn't real until its commit record is in the log.
- **Replication** — a replica is just another machine replaying your log.

## 6. A transaction is the illusion that you're alone

Wrap several statements, and the database pretends *to you* that nothing else is
running, and *to everyone else* that your changes appeared all at once or not at
all.

The illusion is expensive, so it ships with a dial: **isolation levels**, from
"barely pretending" to "fully pretending." You trade throughput for strength.

> Most real bugs in backend code that touches money, inventory or counters are
> someone assuming a stronger illusion than they actually paid for.

## 7. "What if I just edit the files by hand?"

You can — they're only files. What you get is corruption, and *how* it corrupts
is the best available tour of what the gatekeeper was doing for you.

**It isn't text.** A table file is binary 8KB pages: page header, item pointers
at the front, tuples packed from the back, free space between. Each row carries
hidden system columns (`xmin`, `xmax`) recording which transactions created and
deleted it. You'd be hand-editing a length-prefixed binary layout by offset.

Suppose you got the bytes exactly right. It still breaks:

- **The process holds that page in RAM.** Disk is written lazily from the buffer
  pool, so the server either never sees your edit and later flushes its own copy
  over the top — your change silently vanishes — or reads it and hits a state it
  has no path to handle. You're editing a running program's state underneath it.
- **Checksums.** Pages are checksummed. One changed byte and Postgres refuses to
  read the page at all: a small edit becomes an unreadable table.
- **Indexes are separate files.** The evil one. Change an email in the heap and
  the B-tree still points at the old value — so *the same query returns
  different answers depending on the plan*. Index scan finds the old, seq scan
  finds the new. The database is now lying, inconsistently, and nothing crashed
  to tell you.
- **The WAL doesn't know.** Your edit never went through the log, so it isn't
  replicated, isn't in backups, and crash recovery may contradict it. Same for
  the free space map, visibility map, foreign keys, unique constraints.

Which is the real answer: **the gatekeeper's job is maintaining invariants that
span many files at once.** You can only edit one file at a time, so you cannot
preserve them. Stopping the server first fixes the first two problems, not the
rest.

The legitimate forms of "touching the files" all work at a granularity the
database itself guarantees:

| Approach | Why it's safe |
|---|---|
| `pg_dump` | Ask the gatekeeper to serialize everything as SQL |
| Copy the data directory **while stopped** | Cold backup — all files, consistent together |
| `pg_basebackup` / snapshot + WAL archiving | Hot backup made consistent by replaying the log |
| `pageinspect`, `pg_filedump` | Read-only, built for inspecting these structures |

One exception worth knowing: **SQLite's file format is public and stable** on
purpose — it's an archival format, and many tools read `.db` files directly.
Even there, *writing* safely means going through the library, because the
locking protocol lives inside the file.

> The files are an implementation detail of the process, not an interface.

## The one-sentence version

> A database is a long-lived process that keeps more data than fits in memory,
> makes it findable without scanning, lets many clients touch it at once while
> each believes it is alone, and never loses a write it has acknowledged.

## The layers, bottom to top

```
disk (blocks)
  └─ pages: fixed-size units of storage
      └─ WAL: sequential log, the durability mechanism
          └─ buffer pool: hot pages cached in RAM
              └─ access methods: heap scan, B-tree index scan
                  └─ transaction manager: MVCC, locks, isolation
                      └─ planner: SQL -> a chosen execution strategy
                          └─ executor: runs it, returns rows
                              └─ protocol: rows over TCP, back to your server
```

Your Express handler sits at the bottom of `server/README.md`'s stack and at the
*top* of this one — the two diagrams join at "data layer" / "protocol." Every
layer below that point is machinery your handler never sees.
