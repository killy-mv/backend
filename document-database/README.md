# Document Database

`relation-database/` stores data as **rows in tables** and joins them together
when you read them. A document database flips that around. It stores each thing
as **one self-contained JSON-like document**, already shaped the way your app
will read it. Everything below comes from that one choice: what you gain (one
read, no joins, no migrations) and what you pay (duplicates, weaker joins,
schema discipline moves into your code).

The demo uses **MongoDB**, the most widely used document database.

## Run the demo

```
document-database/
├── docker-compose.yml     MongoDB 8 (a one-member replica set, see §6)
└── demo/
    ├── db.js              shared connection + print helpers
    ├── 01-documents.js    CRUD, nested fields, flexible schema, validation
    ├── 02-modeling.js     embed vs. reference, $lookup, the cost of duplicates
    ├── 03-indexes.js      200,000 docs: COLLSCAN vs IXSCAN, compound indexes
    ├── 04-aggregation.js  the pipeline: GROUP BY, $unwind
    └── 05-transactions.js race conditions, atomic updates, multi-doc transactions
```

```powershell
cd document-database
docker compose up -d            # start MongoDB, wait for "(healthy)" in `docker compose ps`
cd demo
npm install
npm run documents               # then: modeling, indexes, aggregation, transactions
npm run all                     # or all five in a row
```

Each lesson drops and recreates its own collections, so you can run them in any
order and as often as you like.

To poke around by hand, open a shell inside the container:

```powershell
docker exec -it learn-mongo mongosh shop
shop> db.users.find()
shop> db.people.find({ city: 'Hue' }).explain('executionStats')
```

When you're done: `docker compose down -v` in `document-database/` stops MongoDB
and deletes the data.

## 1. A document is one nested object

```js
{
  _id: ObjectId('6abb7ee8f5701889a3f83b85'),
  name: 'Alice',
  address: { city: 'Hanoi', street: '12 Hang Bac' },   // would be a 2nd table in SQL
  tags: ['admin', 'beta'],                             // would be a join table in SQL
  createdAt: ISODate('2026-09-29T09:03:36Z')
}
```

| SQL | MongoDB |
|---|---|
| database | database |
| table | **collection** |
| row | **document** (BSON: binary JSON, with extra types like dates and ObjectId) |
| column | field (and it can be an object or an array) |
| primary key | `_id`, always present, always unique |
| JOIN | embedding, or `$lookup` |
| `GROUP BY` | aggregation pipeline (`$group`) |

Things to notice (lesson 1):

- **You query into the structure.** `{ 'address.city': 'Hanoi' }` reaches into a
  nested object. `{ tags: 'beta' }` means "the array contains `beta`".
- **Updates are surgical.** `$set`, `$inc` and `$push` change one field in place.
  `replaceOne` swaps the whole document. Mix those two up and you delete data.
- **`_id` is made by the client.** An ObjectId includes a timestamp and a random
  part, so any server can create one without asking a central counter.
  That helps when writes are spread across many machines (§7).

## 2. "Schemaless" really means the schema lives in your code

The database accepts documents of any shape. That's great when the shape keeps
changing: no `ALTER TABLE`, and no migration that locks a 400GB table. But
lesson 1 §6 shows the other side: `{ nmae: 'Dung' }` is stored happily, and then
`find({ name: 'Dung' })` never finds it again. Nothing crashed, and the user is
still lost.

The schema never goes away. It just moves:

| Where the schema is enforced | Example |
|---|---|
| Nowhere | typos and half-migrated shapes pile up quietly |
| In your app | Mongoose models, zod, TypeScript types |
| In the database, as much as you choose | `$jsonSchema` validator (lesson 1) |

Real apps use the last two together. Over time, a collection often ends up
holding several **versions** of a document shape. Your code must handle all of
them, or you run a backfill script to upgrade the old ones.

## 3. Modeling: store together what you read together

In SQL you normalize first and think about queries later. In a document
database you **start from the queries**: what does each screen or API response
need? Shape the document to match that, so a read is one lookup.

| Embed (a copy inside the parent) | Reference (an `_id` pointing elsewhere) |
|---|---|
| read together, almost always | often read on their own |
| bounded: a few to hundreds of items | unbounded: could grow forever |
| a snapshot is correct (price at purchase) | must always show the current value |
| changes together with the parent | changes independently, often |
| **example:** order → its line items | **example:** post → its comments |

Lesson 2 shows both costs:

- **Duplicates must be updated everywhere.** One author rename rewrites 51
  documents. In SQL it's one row. Forget an `updateMany` and old copies stay
  wrong forever, because the database doesn't know they're related.
- **Documents have a hard 16MB limit.** An array that grows forever (comments,
  logs, followers) will eventually hit it, and it slows down every read of the
  parent before that. Give it its own collection.
- **`$lookup` exists but it's a warning sign when you need it everywhere.** If
  most of your reads need joins, your data is relational, and a relational
  database would serve you better.

## 4. Indexes: the same trade-off as SQL

Underneath, a MongoDB index is a B-tree, the same structure Postgres uses. From
lesson 3, on 200,000 documents:

```
find({ email })  no index    COLLSCAN          200,000 docs examined   ~118ms
find({ email })  with index  EXPRESS_IXSCAN          1 doc  examined     ~3ms
```

- **Compound indexes are used left to right.** `{ city: 1, age: 1 }` serves
  `{city}` and `{city, age}`, but not `{age}` alone, which falls back to COLLSCAN.
  It works like a phone book sorted by last name, then first name.
- **Arrays can be indexed too** (a *multikey* index). Each element gets its own
  entry, so `{ tags: 'beta' }` can use it.
- **Writes pay for every index.** In lesson 3, adding 4 indexes roughly doubled
  the time to insert 50,000 documents. Reads get faster, writes get slower.
  There is no free index.
- **`explain('executionStats')`** is how you check. Compare `totalDocsExamined`
  with `nReturned`. If you read 200,000 documents to return 1, you're missing
  an index.

## 5. The aggregation pipeline

Aggregation is a list of stages. Documents flow through the stages in order, and
each stage transforms the stream:

```
orders ─▶ $match ─▶ $unwind ─▶ $group ─▶ $sort ─▶ $limit ─▶ result
          WHERE     1 doc per   GROUP BY  ORDER BY  LIMIT
                    array item
```

`$unwind` is the stage without a SQL twin. It turns one order with 3 embedded
items into 3 documents with 1 item each, so you can group by product. Put
`$match` first. It can use an index, and every stage after it has less to do.

## 6. Atomicity: one document at a time

This rule shapes MongoDB modeling more than any other:

> **A write to a single document is always atomic.** Writes that touch several
> documents need an explicit transaction.

Lesson 5 shows three cases:

1. **Read, then write in the app: broken.** 20 buyers each read `stock: 5`, and
   each writes back `4`. 20 purchases are accepted for 5 mugs. This is the
   classic lost-update race. It happens in any database, SQL included.
2. **Condition and change in one update: correct.**
   `updateOne({ _id, stock: { $gt: 0 } }, { $inc: { stock: -1 } })` accepts
   exactly 5. The check and the write happen together inside the database.
3. **Two documents: transaction.** A transfer debits Alice and credits Bob.
   If it crashes between the two writes, `withTransaction` rolls back the debit.

That's also why embedding matters. If everything that must change together
lives in one document, case 2 covers you and you rarely need case 3.
Transactions exist, but they cost more than single-document writes, and
MongoDB only supports them on a **replica set**. That's why
`docker-compose.yml` runs a replica set with one member.

## 7. Scaling out: replica sets and sharding

Document databases were designed to spread across machines. Self-contained
documents make that natural, because a document can live on any server without
its related rows.

- **Replica set:** 1 primary takes writes, and secondaries copy its operation
  log (the same idea as the WAL in `relation-database/`). If the primary dies,
  the others elect a new one within seconds.
- **Sharding:** a collection is split across servers by a **shard key**, such as
  `customerId`. Queries that include the shard key go to one server. Queries
  without it must ask every server. Choosing the shard key is the most
  important and least reversible decision you'll make at that scale.

## When to use which

| Pick a document DB when... | Pick a relational DB when... |
|---|---|
| records are mostly self-contained (profiles, catalogs, CMS content, events) | data is highly connected (users ↔ orders ↔ products ↔ payments) |
| the shape varies or changes often | the shape is stable and integrity rules matter |
| you read and write whole objects by id | you need ad-hoc queries and reporting you can't predict |
| you expect to shard across many machines | consistency across many records is the core of the app (money, inventory) |

If you're unsure, Postgres with a `JSONB` column gives you documents inside a
relational database. It's a sensible default until you know you need more.

## Words you'll see

| Term | Meaning |
|---|---|
| **BSON** | the binary JSON format documents are stored in, with dates, ObjectId, decimals |
| **ObjectId** | the default `_id`: 12 bytes = timestamp + random + counter |
| **Embedding** | putting related data inside the parent document |
| **Denormalization** | deliberately storing the same fact in several places for faster reads |
| **COLLSCAN / IXSCAN** | reading every document / walking an index |
| **Multikey index** | an index on an array field: one entry per element |
| **Replica set** | a primary plus copies, with automatic failover |
| **Shard key** | the field that decides which server a document lives on |
