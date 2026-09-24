import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from './config'
import { query, transaction } from './db'

export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export function passwordMatches(password: string) {
  return timingSafeEqual(
    Buffer.from(digest(password), 'hex'),
    Buffer.from(digest(config().OWNER_PASSWORD), 'hex'),
  )
}
export async function attemptLogin(password: string, ip: string) {
  const key = createHmac('sha256', config().SESSION_SECRET).update(ip).digest('hex')
  const allowed = await transaction(async (db) => {
    await query("DELETE FROM login_attempts WHERE window_start<now()-interval '10 minutes'", [], db)
    const [row] = await query(
      'INSERT INTO login_attempts(key,attempts) VALUES($1,1) ON CONFLICT(key) DO UPDATE SET attempts=login_attempts.attempts+1 RETURNING attempts',
      [key],
      db,
    )
    return row!.attempts <= 8
  })
  if (!allowed) throw new Error('LOGIN_RATE_LIMIT')
  if (!passwordMatches(password)) throw new Error('LOGIN_FAILED')
  const token = randomBytes(32).toString('base64url')
  await query('DELETE FROM sessions WHERE expires_at<now()')
  await query("INSERT INTO sessions(token_hash,expires_at) VALUES($1,now()+interval '12 hours')", [
    digest(token),
  ])
  return token
}
export async function validSession(token?: string) {
  return (
    !!token &&
    token.length <= 100 &&
    (
      await query('SELECT token_hash FROM sessions WHERE token_hash=$1 AND expires_at>now()', [
        digest(token),
      ])
    ).length === 1
  )
}
