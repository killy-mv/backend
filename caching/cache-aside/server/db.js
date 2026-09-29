// The "database": a real Postgres (from ../../docker-compose.yml) holding 1,000
// products. The only thing faked is speed. Real apps have queries that take
// seconds (big joins, reports, a slow third-party API), so we make ours slow on
// purpose with pg_sleep. It's a real sleep *inside* Postgres, so a slow query
// really does occupy a database connection the whole time, just like the real thing.

import pg from 'pg'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://shop:shop@localhost:5432/shop',
  // A database can only run a handful of queries at once. 10 is pg's default and
  // a realistic number. Request #11 waits in line for a free connection.
  max: 10,
})

// Slow mode = each product lookup takes a random 1–2 seconds. Toggled from the
// page (or by stress.js --fast) so you can compare a slow DB with a fast one.
export const settings = { slowDb: true }

export let dbQueries = 0 // how many times we actually asked Postgres for a product
export function resetDbQueries() { dbQueries = 0 }

export async function findProduct(id) {
  dbQueries++
  const delaySec = settings.slowDb ? 1 + Math.random() : 0
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.price::float8 AS price
       FROM products p, pg_sleep($1)
      WHERE p.id = $2`,
    [delaySec, id],
  )
  return rows[0] ?? null
}

export async function updatePrice(id, price) {
  const { rows } = await pool.query(
    'UPDATE products SET price = $1 WHERE id = $2 RETURNING id, name, price::float8 AS price',
    [price, id],
  )
  return rows[0] ?? null
}

// Fast, unsleeping reads for the page itself (the product list, the debug peek).
// These aren't part of the experiment, so they skip the delay and the counter.
export async function listProducts(limit = 20) {
  const { rows } = await pool.query(
    'SELECT id, name, price::float8 AS price FROM products ORDER BY id LIMIT $1',
    [limit],
  )
  return rows
}

export async function peekProduct(id) {
  const { rows } = await pool.query(
    'SELECT id, name, price::float8 AS price FROM products WHERE id = $1',
    [id],
  )
  return rows[0] ?? null
}

// Create and fill the table the first time the server starts.
export async function setup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id    serial PRIMARY KEY,
      name  text NOT NULL,
      price numeric(10, 2) NOT NULL
    )`)
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM products')
  if (rows[0].n > 0) return

  const adjectives = ['Cozy', 'Rugged', 'Tiny', 'Smart', 'Vintage', 'Electric', 'Silent', 'Golden', 'Foldable', 'Turbo']
  const things = ['Mug', 'Backpack', 'Lamp', 'Keyboard', 'Kettle', 'Chair', 'Headphones', 'Notebook', 'Umbrella', 'Toaster']
  const names = []
  const prices = []
  for (let i = 0; i < 1000; i++) {
    names.push(`${adjectives[i % 10]} ${things[Math.floor(i / 10) % 10]} #${i + 1}`)
    prices.push((5 + Math.random() * 195).toFixed(2))
  }
  await pool.query(
    'INSERT INTO products (name, price) SELECT * FROM unnest($1::text[], $2::numeric[])',
    [names, prices],
  )
  console.log('seeded 1,000 products')
}
