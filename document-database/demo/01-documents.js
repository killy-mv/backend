// Lesson 1: what a document is, CRUD, and what "flexible schema" really costs.
// See ../README.md §1–2.

import { db, run, section, show } from './db.js'

await run(async () => {
  const users = db.collection('users')
  await users.drop().catch(() => {}) // start fresh every run (throws if it doesn't exist)

  section('1. Insert: a document is one nested object, not a row')
  const { insertedId } = await users.insertOne({
    name: 'Alice',
    email: 'alice@example.com',
    address: { city: 'Hanoi', street: '12 Hang Bac' }, // nested object, no second table
    tags: ['admin', 'beta'], // array, no join table
    createdAt: new Date(),
  })
  show('insertedId', insertedId)
  // _id is an ObjectId: 12 bytes, and the first 4 are a timestamp. The client
  // makes it, not the server, so there's no "wait for the next auto-increment".
  show('...which was created at', insertedId.getTimestamp())

  section('2. Same collection, different shapes: no ALTER TABLE needed')
  await users.insertMany([
    { name: 'Bob', email: 'bob@example.com', address: { city: 'Da Nang' }, tags: [] },
    { name: 'Chi', email: 'chi@example.com', phone: '+84 90 000 0000', tags: ['beta'] }, // no address, has phone
  ])
  show('all users', await users.find({}, { projection: { _id: 0 } }).toArray())

  section('3. Query INTO the document')
  // Dot notation reaches inside nested objects.
  show("address.city = 'Hanoi'", await users.find({ 'address.city': 'Hanoi' }).project({ _id: 0, name: 1 }).toArray())
  // Matching a plain value against an array means "the array contains it".
  show("tags contains 'beta'", await users.find({ tags: 'beta' }).project({ _id: 0, name: 1 }).toArray())
  show('has a phone field', await users.find({ phone: { $exists: true } }).project({ _id: 0, name: 1 }).toArray())

  section('4. Update with operators: change part of a document in place')
  await users.updateOne(
    { email: 'bob@example.com' },
    {
      $set: { 'address.street': '5 Bach Dang' }, // set one nested field
      $push: { tags: 'new' }, // append to an array
      $inc: { loginCount: 1 }, // field didn't exist, so it starts at 0
    },
  )
  show('bob after update', await users.findOne({ name: 'Bob' }, { projection: { _id: 0 } }))

  // replaceOne is the trap: it swaps the WHOLE document for the one you pass.
  await users.replaceOne({ name: 'Bob' }, { name: 'Bob', email: 'bob@example.com' })
  show('bob after replaceOne (address, tags, loginCount gone)', await users.findOne({ name: 'Bob' }, { projection: { _id: 0 } }))

  section('5. Delete')
  const { deletedCount } = await users.deleteOne({ name: 'Chi' })
  show('deletedCount', deletedCount)

  section('6. The cost of "flexible": the database accepts your typos')
  await users.insertOne({ nmae: 'Dung', emial: 'dung@example.com' }) // oops
  show('stored without complaint', await users.findOne({ nmae: 'Dung' }, { projection: { _id: 0 } }))
  show("find({ name: 'Dung' })", await users.findOne({ name: 'Dung' })) // null: the user is "lost"

  // Fix: attach a validator. The schema moves back into the database, but
  // only as strict as you choose (here: just name + email required).
  await users.deleteOne({ nmae: 'Dung' })
  await db.command({
    collMod: 'users',
    validator: {
      $jsonSchema: {
        required: ['name', 'email'],
        properties: {
          name: { bsonType: 'string' },
          email: { bsonType: 'string', pattern: '^.+@.+$' },
        },
      },
    },
  })
  try {
    await users.insertOne({ nmae: 'Dung', emial: 'dung@example.com' })
  } catch (err) {
    show('with a validator', `rejected: ${err.message}`)
  }
  await users.insertOne({ name: 'Dung', email: 'dung@example.com', anyExtraField: 'still allowed' })
  show('a valid document still gets in, extra fields and all', await users.countDocuments({ name: 'Dung' }))
})
