// Shared by every lesson: one connection to the MongoDB from ../docker-compose.yml,
// plus two tiny print helpers so the output reads like a walkthrough.

import { MongoClient } from 'mongodb'
import { inspect } from 'node:util'

// directConnection=true: talk to this one server as-is. Without it the driver
// asks the replica set for its member list and then connects to what the set
// *calls itself* ("localhost:27017"), which only works because we mapped that port.
const url = process.env.MONGO_URL ?? 'mongodb://localhost:27017/?directConnection=true'

export const client = new MongoClient(url)
export const db = client.db('shop') // created lazily, on the first write

// Run a lesson, and always close the connection so the process can exit.
export async function run(lesson) {
  try {
    await client.connect()
    await lesson()
  } catch (err) {
    if (err.name === 'MongoServerSelectionError') {
      console.error('Cannot reach MongoDB. Run `docker compose up -d` in document-database/ first.')
    } else {
      console.error(err)
    }
    process.exitCode = 1
  } finally {
    await client.close()
  }
}

export function section(title) {
  console.log(`\n=== ${title} ${'='.repeat(Math.max(0, 70 - title.length))}`)
}

export function show(label, value) {
  const text = typeof value === 'string' ? value : inspect(value, { depth: 6, colors: true, breakLength: 100 })
  console.log(`${label}:`, text)
}
