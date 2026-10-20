import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { config } from '../config'
import { WALLET_POLICY } from '../policy'

/**
 * Read-only Bybit client for the deposit watcher. It has GET requests only: no order, transfer
 * or withdrawal call exists here, and the key itself must be read-only on Bybit's side.
 * Errors are codes; the key, the secret and the signed URL are never logged or returned.
 */
export type WalletCredentials = { key: string; secret: string }
export type WalletTransport = typeof fetch

export function walletCredentials(): WalletCredentials | null {
  const c = config()
  if (!c.BYBIT_WALLET_READ_API_KEY || !c.BYBIT_WALLET_READ_SECRET) return null
  return { key: c.BYBIT_WALLET_READ_API_KEY, secret: c.BYBIT_WALLET_READ_SECRET }
}

export class WalletClient {
  constructor(
    private credentials: WalletCredentials,
    private transport: WalletTransport = fetch,
    private host = config().BYBIT_API_HOST,
  ) {}

  private async get(path: string, params: Record<string, string> = {}) {
    const query = new URLSearchParams(params).toString()
    const stamp = String(Date.now())
    const window = '5000'
    const { key, secret } = this.credentials
    const headers = {
      'X-BAPI-API-KEY': key,
      'X-BAPI-TIMESTAMP': stamp,
      'X-BAPI-RECV-WINDOW': window,
      'X-BAPI-SIGN': createHmac('sha256', secret)
        .update(stamp + key + window + query)
        .digest('hex'),
    }
    let response: Response
    try {
      response = await this.transport(`https://${this.host}${path}${query ? '?' + query : ''}`, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new Error('WALLET_NETWORK_UNAVAILABLE')
    }
    if (response.status === 429) throw new Error('WALLET_RATE_LIMIT')
    if (response.status === 401) throw new Error('WALLET_KEY_INVALID')
    if (response.status === 403 || response.status === 451)
      throw new Error('WALLET_REGION_UNAVAILABLE')
    if (response.status >= 500) throw new Error('WALLET_NETWORK_UNAVAILABLE')
    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      throw new Error('WALLET_RESPONSE_INVALID')
    }
    const parsed = z.object({ retCode: z.number().int(), result: z.unknown() }).safeParse(raw)
    if (!parsed.success) throw new Error('WALLET_RESPONSE_INVALID')
    const code = parsed.data.retCode
    if (code === 0) return parsed.data.result
    // 10003 invalid key, 10004 bad signature, 10005 no permission, 10010 IP not allowed.
    if (code === 10003 || code === 33004) throw new Error('WALLET_KEY_INVALID')
    if (code === 10004) throw new Error('WALLET_KEY_SIGNATURE')
    if (code === 10005) throw new Error('WALLET_KEY_NO_PERMISSION')
    if (code === 10010) throw new Error('WALLET_KEY_IP_NOT_ALLOWED')
    if (code === 10006 || code === 10018) throw new Error('WALLET_RATE_LIMIT')
    throw new Error(`WALLET_EXCHANGE_ERROR_${Math.abs(code)}`)
  }

  /** `/v5/user/query-api`: whether this key is read-only. */
  async keyInfo() {
    const r = z
      .object({
        readOnly: z.union([z.number().int(), z.string().regex(/^\d$/).transform(Number)]),
        permissions: z.record(z.string(), z.array(z.string())).default({}),
        ips: z.array(z.string()).default([]),
      })
      .safeParse(await this.get('/v5/user/query-api'))
    if (!r.success) throw new Error('WALLET_RESPONSE_INVALID')
    return r.data
  }

  /** Cursor-paginated rows of a deposit history endpoint over [start, end] (ms, ≤ 30 days). */
  async pages(path: string, start: number, end: number) {
    const rows: unknown[] = []
    const seen = new Set<string>()
    let cursor = ''
    for (let page = 0; page < WALLET_POLICY.maxPages; page++) {
      const params: Record<string, string> = {
        startTime: String(start),
        endTime: String(end),
        limit: String(WALLET_POLICY.pageLimit),
      }
      if (cursor) params.cursor = cursor
      const r = z
        .object({ rows: z.array(z.unknown()).default([]), nextPageCursor: z.string().default('') })
        .safeParse(await this.get(path, params))
      if (!r.success) throw new Error('WALLET_RESPONSE_INVALID')
      rows.push(...r.data.rows)
      cursor = r.data.nextPageCursor
      if (!cursor || !r.data.rows.length || seen.has(cursor)) return rows
      seen.add(cursor)
    }
    throw new Error('WALLET_PAGE_LIMIT')
  }
}

/** A read-only key is the only kind the watcher accepts. */
export function assertReadOnly(info: { readOnly: number; permissions: Record<string, string[]> }) {
  const withdraw = Object.values(info.permissions).some((list) =>
    list.some((p) => /withdraw/i.test(p)),
  )
  if (info.readOnly !== 1 || withdraw) throw new Error('WALLET_KEY_NOT_READ_ONLY')
}
