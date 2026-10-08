import { createHmac } from 'node:crypto'
import { isIPv6 } from 'node:net'
import { config } from './config'
import { audit, query } from './db'

/**
 * Fixed-window limits for the public buyer API, stored like `login_attempts`. The key is
 * HMAC(SESSION_SECRET, route:ip): the database never sees the address itself.
 */
export const publicLimits = Object.freeze({
  catalog: { limit: 120, windowSeconds: 60 },
  service: { limit: 120, windowSeconds: 60 },
  createOrder: { limit: 10, windowSeconds: 3600 },
  order: { limit: 120, windowSeconds: 60 },
  pay: { limit: 20, windowSeconds: 3600 },
  result: { limit: 60, windowSeconds: 60 },
})
export type PublicRoute = keyof typeof publicLimits

/** Unknown order links across all buyers before an audit event, per 10 minutes. */
export const probeLimit = { limit: 50, windowSeconds: 600 }

/**
 * The unit a limit counts. One IPv6 subscriber usually owns a whole /64, so IPv6 addresses
 * count by their first 64 bits; IPv4-mapped addresses count as plain IPv4.
 */
export function limitAddress(ip: string) {
  let address = ip.trim().toLowerCase()
  const zone = address.indexOf('%')
  if (zone >= 0) address = address.slice(0, zone)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)
  if (mapped) return mapped[1]!
  if (!isIPv6(address)) return ip
  const width = (groups: string[]) =>
    groups.reduce((n, group) => n + (group.includes('.') ? 2 : 1), 0)
  const [head = '', tail] = address.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - width(left) - width(right)).fill('0'), ...right]
  return (
    groups
      .slice(0, 4)
      .map((group) => parseInt(group, 16).toString(16))
      .join(':') + '::/64'
  )
}

export function clientKey(ip: string, secret = config().SESSION_SECRET) {
  return createHmac('sha256', secret)
    .update(`client:${limitAddress(ip)}`)
    .digest('hex')
}
export function rateLimitKey(route: string, ip: string, secret = config().SESSION_SECRET) {
  return createHmac('sha256', secret)
    .update(`${route}:${limitAddress(ip)}`)
    .digest('hex')
}

/** Next counter state for one hit. Pure, so tests can check window edges without a database. */
export function nextWindow(
  current: { attempts: number; windowStart: Date } | null,
  now: Date,
  windowSeconds: number,
) {
  if (!current || now.getTime() - current.windowStart.getTime() >= windowSeconds * 1000)
    return { attempts: 1, windowStart: now }
  return { attempts: current.attempts + 1, windowStart: current.windowStart }
}

async function hit(key: string, windowSeconds: number) {
  const [row] = await query(
    `INSERT INTO rate_limits(key,attempts,window_start) VALUES($1,1,clock_timestamp())
     ON CONFLICT(key) DO UPDATE SET
       attempts=CASE WHEN rate_limits.window_start<=clock_timestamp()-make_interval(secs=>$2)
         THEN 1 ELSE rate_limits.attempts+1 END,
       window_start=CASE WHEN rate_limits.window_start<=clock_timestamp()-make_interval(secs=>$2)
         THEN clock_timestamp() ELSE rate_limits.window_start END
     RETURNING attempts`,
    [key, windowSeconds],
  )
  // Old counters are useless after the longest window; trim them now and then.
  if (Math.random() < 0.02)
    await query("DELETE FROM rate_limits WHERE window_start<now()-interval '2 hours'")
  return row!.attempts as number
}

/** Counts one request; throws RATE_LIMITED (429) once the route's window is full. */
export async function checkRateLimit(route: PublicRoute, ip: string) {
  const { limit, windowSeconds } = publicLimits[route]
  if ((await hit(rateLimitKey(route, ip), windowSeconds)) > limit) throw new Error('RATE_LIMITED')
}

/**
 * Called for every unknown or malformed order link. A 256-bit token cannot be guessed, but a
 * burst of misses means someone is probing. The audit event carries no address or key.
 */
export async function recordTokenMiss() {
  const attempts = await hit(rateLimitKey('token-probe', 'all'), probeLimit.windowSeconds)
  if (attempts === probeLimit.limit)
    await audit(
      'public_token_probe',
      `Похоже на перебор ссылок заказов: ${probeLimit.limit} неизвестных ссылок за 10 минут.`,
      { misses: attempts, windowSeconds: probeLimit.windowSeconds },
    )
}
