// Lesson 5: atomicity. One document is always all-or-nothing. More than one
// document needs a transaction. See ../README.md §6.

import { client, db, run, section, show } from './db.js'

await run(async () => {
  const products = db.collection('products')
  const accounts = db.collection('accounts')
  await Promise.all([products, accounts].map((c) => c.drop().catch(() => {})))

  const BUYERS = 20

  section(`1. ${BUYERS} people buy the last 5 mugs at once: read, then write`)
  await products.insertOne({ _id: 'MUG-1', stock: 5 })

  async function buyNaive() {
    const mug = await products.findOne({ _id: 'MUG-1' }) // 1. read
    if (mug.stock <= 0) return false // 2. decide in the app
    await products.updateOne({ _id: 'MUG-1' }, { $set: { stock: mug.stock - 1 } }) // 3. write
    return true
  }
  let results = await Promise.all(Array.from({ length: BUYERS }, buyNaive))
  show('purchases accepted', results.filter(Boolean).length)
  show('stock left', (await products.findOne({ _id: 'MUG-1' })).stock)
  // Everyone read "stock: 5" before anyone wrote. Each one wrote 4. You sold
  // up to 20 mugs you don't have, and the stock counter says 4.

  section(`2. Same ${BUYERS} buyers: check and change in ONE atomic update`)
  await products.updateOne({ _id: 'MUG-1' }, { $set: { stock: 5 } })

  async function buyAtomic() {
    // The condition and the change run as one step inside the database.
    // A single-document update is always atomic, so no one can slip between them.
    const { modifiedCount } = await products.updateOne({ _id: 'MUG-1', stock: { $gt: 0 } }, { $inc: { stock: -1 } })
    return modifiedCount === 1
  }
  results = await Promise.all(Array.from({ length: BUYERS }, buyAtomic))
  show('purchases accepted', results.filter(Boolean).length)
  show('stock left', (await products.findOne({ _id: 'MUG-1' })).stock)
  // Exactly 5. This covers most real cases, which is WHY documents embed:
  // if everything that changes together is in one document, you rarely need more.

  section('3. Moving money touches TWO documents: that needs a transaction')
  await accounts.insertMany([
    { _id: 'alice', balance: 100 },
    { _id: 'bob', balance: 0 },
  ])
  const balances = async () => Object.fromEntries((await accounts.find().toArray()).map((a) => [a._id, a.balance]))

  async function transfer(from, to, amount, { crashHalfway = false } = {}) {
    const session = client.startSession()
    try {
      // withTransaction commits at the end, or aborts if anything throws
      // (and retries on transient errors like a write conflict).
      await session.withTransaction(async () => {
        const { modifiedCount } = await accounts.updateOne(
          { _id: from, balance: { $gte: amount } },
          { $inc: { balance: -amount } },
          { session }, // every operation must carry the session to be part of it
        )
        if (modifiedCount === 0) throw new Error('insufficient funds')
        if (crashHalfway) throw new Error('server crashed after the debit!')
        await accounts.updateOne({ _id: to }, { $inc: { balance: amount } }, { session })
      })
      return 'committed'
    } catch (err) {
      return `aborted (${err.message})`
    } finally {
      await session.endSession()
    }
  }

  show('before', await balances())
  show('transfer 30 alice -> bob', await transfer('alice', 'bob', 30))
  show('after', await balances())
  show('transfer 30, crash after the debit', await transfer('alice', 'bob', 30, { crashHalfway: true }))
  show('after', await balances()) // alice NOT debited: the half-done work was rolled back
  show('transfer 500 alice -> bob', await transfer('alice', 'bob', 500))
  show('after', await balances())
})
