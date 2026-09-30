// Lesson 4: the aggregation pipeline, MongoDB's answer to GROUP BY.
// See ../README.md §5.

import { db, run, section, show } from './db.js'

const products = [
  { sku: 'MUG-1', name: 'Cozy Mug', price: 12.5 },
  { sku: 'LAMP-1', name: 'Tiny Lamp', price: 30 },
  { sku: 'KB-1', name: 'Smart Keyboard', price: 89 },
  { sku: 'BAG-1', name: 'Rugged Backpack', price: 55 },
]
const customers = ['Alice', 'Bob', 'Chi', 'Dung', 'Em']
const cities = ['Hanoi', 'Da Nang', 'Saigon']

await run(async () => {
  const orders = db.collection('orders')
  await orders.drop().catch(() => {})

  // 1,000 orders, each embedding 1–3 line items (the snapshot model from lesson 2).
  const docs = Array.from({ length: 1000 }, (_, i) => {
    const items = Array.from({ length: 1 + (i % 3) }, (_, j) => {
      const p = products[(i + j) % products.length]
      return { ...p, qty: 1 + ((i * 7 + j) % 4) }
    })
    return {
      customer: customers[i % customers.length],
      city: cities[Math.floor(i / 7) % cities.length],
      status: i % 10 === 0 ? 'cancelled' : 'paid',
      items,
      total: items.reduce((sum, it) => sum + it.price * it.qty, 0),
    }
  })
  await orders.insertMany(docs)
  show('seeded orders', await orders.countDocuments())
  show('one order looks like', await orders.findOne({}, { projection: { _id: 0 } }))

  section('1. Revenue per city')
  // SQL: SELECT city, SUM(total), COUNT(*) FROM orders WHERE status = 'paid'
  //      GROUP BY city ORDER BY revenue DESC
  const perCity = await orders
    .aggregate([
      { $match: { status: 'paid' } }, // WHERE (put it first, so it can use an index)
      { $group: { _id: '$city', revenue: { $sum: '$total' }, orders: { $sum: 1 } } }, // GROUP BY
      { $sort: { revenue: -1 } }, // ORDER BY
    ])
    .toArray()
  console.table(perCity)

  section('2. Best-selling products: reach inside the embedded arrays')
  // $unwind turns 1 order with 3 items into 3 documents with 1 item each.
  // It's how you "join" an order with its own line items.
  const bestSellers = await orders
    .aggregate([
      { $match: { status: 'paid' } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          unitsSold: { $sum: '$items.qty' },
          revenue: { $sum: { $multiply: ['$items.price', '$items.qty'] } },
        },
      },
      { $sort: { unitsSold: -1 } },
      { $limit: 3 },
    ])
    .toArray()
  console.table(bestSellers)

  section('3. Top customers, reshaped for an API response')
  const top = await orders
    .aggregate([
      { $match: { status: 'paid' } },
      { $group: { _id: '$customer', spent: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { spent: -1 } },
      { $limit: 3 },
      // $project reshapes each result, like choosing columns in SELECT.
      { $project: { _id: 0, customer: '$_id', spent: 1, avgOrder: { $round: [{ $divide: ['$spent', '$orders'] }, 2] } } },
    ])
    .toArray()
  show('top customers', top)
})
