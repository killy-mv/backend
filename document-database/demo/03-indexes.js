// Lesson 3: indexes. Same B-tree idea as relational-land, same trade-off.
// See ../README.md §4.

import { db, run, section, show } from './db.js'

const N = 200_000
const cities = ['Hanoi', 'Da Nang', 'Hue', 'Saigon', 'Can Tho', 'Hai Phong', 'Nha Trang', 'Vung Tau']

// The parts of explain() worth reading: which plan, and how much work it did.
async function explain(cursor) {
  const { queryPlanner, executionStats: s } = await cursor.explain('executionStats')
  const stages = []
  for (let p = queryPlanner.winningPlan.queryPlan ?? queryPlanner.winningPlan; p; p = p.inputStage) stages.push(p.stage)
  return {
    plan: stages.join(' <- '), // COLLSCAN = read every document; IXSCAN = walk the index
    docsExamined: s.totalDocsExamined,
    keysExamined: s.totalKeysExamined,
    returned: s.nReturned,
    ms: s.executionTimeMillis,
  }
}

await run(async () => {
  const people = db.collection('people')
  await people.drop().catch(() => {})

  section(`Seeding ${N.toLocaleString()} people`)
  for (let start = 0; start < N; start += 10_000) {
    await people.insertMany(
      Array.from({ length: 10_000 }, (_, j) => {
        const i = start + j
        return { email: `user${i}@example.com`, city: cities[i % cities.length], age: 18 + (Math.floor(i / cities.length) % 60) }
      }),
      { ordered: false },
    )
  }
  show('count', await people.estimatedDocumentCount())
  show('indexes that exist by default', (await people.indexes()).map((ix) => ix.name)) // only _id

  const byEmail = { email: 'user150000@example.com' }

  section('1. Find one person by email, no index')
  show('explain', await explain(people.find(byEmail)))
  // 200,000 documents read to return 1. That is O(n), and n only grows.

  section('2. Same query, with an index on email')
  const t0 = performance.now()
  await people.createIndex({ email: 1 }, { unique: true })
  show('building the index took', `${Math.round(performance.now() - t0)}ms`)
  show('explain', await explain(people.find(byEmail)))
  // 1 key, 1 document. (EXPRESS_IXSCAN is MongoDB 8's shortcut for an exact
  // match on a unique index: IXSCAN + FETCH in one step.) unique: true also
  // makes the database reject a second user with the same email, the same job
  // as a UNIQUE constraint.

  section('3. Compound index: field order matters')
  await people.createIndex({ city: 1, age: 1 })
  // Works: city is the index's first field (its "prefix").
  show("{ city: 'Hue', age: 30 }", await explain(people.find({ city: 'Hue', age: 30 })))
  show("{ city: 'Hue' }", await explain(people.find({ city: 'Hue' })))
  // Can't use it: age alone isn't a prefix. Like a phone book sorted by
  // (last name, first name): useless for "everyone named Minh".
  show('{ age: 30 }', await explain(people.find({ age: 30 })))

  section('4. The price: every index is updated on every write')
  const bench = db.collection('bench')
  for (const withIndexes of [false, true]) {
    await bench.drop().catch(() => {})
    if (withIndexes) {
      await bench.createIndexes([{ key: { email: 1 } }, { key: { city: 1, age: 1 } }, { key: { age: 1 } }, { key: { city: 1 } }])
    }
    const docs = Array.from({ length: 50_000 }, (_, i) => ({ email: `u${i}@x.com`, city: cities[i % 8], age: i % 60 }))
    const t = performance.now()
    await bench.insertMany(docs)
    show(`insert 50,000 docs, ${withIndexes ? '4 extra indexes' : 'only _id index'}`, `${Math.round(performance.now() - t)}ms`)
  }
  await bench.drop()
  // Reads get faster, writes get slower. There is no free index.
})
