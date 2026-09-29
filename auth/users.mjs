// The "users table", shared by all three examples.
//
// credentials.txt is plaintext so you know what to type into the forms. A real
// users table never holds passwords -- only a salt and a slow hash (README §9).
// So we hash everything once at startup and drop the plaintext; from here on
// this module only knows what a real database would know.

import { readFileSync } from 'node:fs'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const KEY_LEN = 64

// scrypt is slow on purpose (tens of ms) so a stolen table is expensive to
// crack. The async version runs on libuv's thread pool, so it doesn't block
// the event loop (../server/README.md §6).
const hash = (password, salt) => scryptAsync(password.normalize('NFC'), salt, KEY_LEN)

const users = new Map()

const file = new URL('./credentials.txt', import.meta.url)
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) continue
  const [username, password, role = 'user'] = trimmed.split(':')
  const salt = randomBytes(16)
  users.set(username, { username, role, salt, hash: await hash(password, salt) })
}

const toPublic = ({ username, role }) => ({ username, role })

// Unknown users still pay for a full hash, and both failures return the same
// null -- so neither timing nor the response reveals which usernames exist.
const dummy = { salt: randomBytes(16), hash: randomBytes(KEY_LEN) }

export async function checkPassword(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null
  const user = users.get(username)
  const { salt, hash: expected } = user ?? dummy
  const ok = timingSafeEqual(await hash(password, salt), expected)
  return ok && user ? toPublic(user) : null
}

export function findUser(username) {
  const user = users.get(username)
  return user ? toPublic(user) : null
}
