import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The server reads its configuration once per process: set the wallet before any import.
const saved = vi.hoisted(() => {
  const values: Record<string, string> = {
    BYBIT_WALLET_READ_API_KEY: 'wallet-read-key',
    BYBIT_WALLET_READ_SECRET: 'wallet-read-secret-never-logged',
    PAYMENT_USDT_ADDRESS: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
    PAYMENT_USDT_NETWORK: 'TRC20',
  }
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  return before
})

import { createServer, type Server } from 'node:http'
import { createApp, createRouter, toNodeListener } from 'h3'
import { pool, query } from '../../core/db'
import { attemptLogin } from '../../core/auth'
import { walletTick } from '../../core/wallet/sync'
import security from '../../server/middleware/security'
import income from '../../server/api/office/income.get'
import wallet from '../../server/api/office/wallet/index.get'
import classify from '../../server/api/office/wallet/deposits/[id].post'
import type { OfficeIncome } from '../../core/contracts/overview'
import type { OfficeWallet } from '../../core/contracts/wallet'
import { applyMigrations, resetDatabase } from './helpers/db'

let server: Server
let base = ''

beforeAll(async () => {
  await applyMigrations()
  const app = createApp()
  app.use(security)
  const router = createRouter()
  router.get('/api/office/income', income)
  router.get('/api/office/wallet', wallet)
  router.post('/api/office/wallet/deposits/:id', classify)
  app.use(router)
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(() => resetDatabase())
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await pool.end()
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
})

const now = Date.now()
const onchain = (txID: string, amount: string, status: number, minutesAgo = 10) => ({
  id: `id-${txID}`,
  coin: 'USDT',
  chain: 'TRX',
  amount,
  txID,
  status,
  toAddress: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
  tag: '',
  depositFee: '',
  successAt: status === 3 ? String(now - minutesAgo * 60_000) : '',
  confirmations: '20',
  txIndex: '0',
  blockHash: 'ff',
  batchReleaseLimit: '-1',
  depositType: '0',
})

type Bybit = {
  readOnly: number
  pages: unknown[][]
  internal: unknown[]
}
function bybit(state: Bybit) {
  const calls: { path: string; params: URLSearchParams; headers: Record<string, string> }[] = []
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = init?.headers as Record<string, string>
    calls.push({ path: url.pathname, params: url.searchParams, headers })
    expect(init?.method).toBe('GET')
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result }), { status: 200 })
    if (url.pathname === '/v5/user/query-api')
      return ok({ readOnly: state.readOnly, permissions: { Wallet: [] }, ips: ['89.19.215.46'] })
    if (url.pathname === '/v5/asset/deposit/query-record') {
      const page = Number(url.searchParams.get('cursor') || 0)
      return ok({
        rows: state.pages[page] ?? [],
        nextPageCursor: page + 1 < state.pages.length ? String(page + 1) : '',
      })
    }
    if (url.pathname === '/v5/asset/deposit/query-internal-record')
      return ok({ rows: state.internal, nextPageCursor: '' })
    return new Response('{}', { status: 404 })
  })
  return { transport: transport as unknown as typeof fetch, calls }
}

const get = async <T>(path: string, cookie: string) => {
  const response = await fetch(base + path, { headers: { cookie: `farm_session=${cookie}` } })
  return { status: response.status, json: (await response.json()) as T }
}
const post = async (path: string, body: unknown, cookie?: string) => {
  const text = JSON.stringify(body)
  const response = await fetch(base + path, {
    method: 'POST',
    headers: {
      origin: 'http://localhost:3210',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(text)),
      ...(cookie ? { cookie: `farm_session=${cookie}` } : {}),
    },
    body: text,
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}
const auditCount = async (kind: string) =>
  Number((await query('SELECT count(*)::int AS n FROM audit_events WHERE kind=$1', [kind]))[0]!.n)

describe('Bybit wallet deposits', () => {
  it('syncs every page idempotently and counts only owner-marked income', async () => {
    const state: Bybit = {
      readOnly: 1,
      pages: [
        [
          onchain('tx-paid', '125.5', 3, 30),
          onchain('tx-pending', '40', 1),
          onchain('tx-failed', '999', 4),
        ],
        [onchain('tx-own', '500.000000', 3, 60)],
      ],
      internal: [
        {
          id: 'int-1',
          type: 1,
          coin: 'USDT',
          amount: '20',
          status: 2,
          address: 'client@example.com',
          createdTime: String(Math.floor((now - 5 * 60_000) / 1000)),
          txID: '',
        },
      ],
    }
    const { transport, calls } = bybit(state)
    expect(await walletTick({ transport })).toMatchObject({ status: 'read_only', seen: 5 })
    // Both pages, a signed request with the key, and never the secret on the wire.
    const deposits = calls.filter((c) => c.path === '/v5/asset/deposit/query-record')
    expect(deposits.map((c) => c.params.get('cursor'))).toEqual([null, '1'])
    const span =
      Number(deposits[0]!.params.get('endTime')) - Number(deposits[0]!.params.get('startTime'))
    expect(span).toBeLessThanOrEqual(30 * 24 * 3600_000)
    for (const c of calls) {
      expect(c.headers['X-BAPI-API-KEY']).toBe('wallet-read-key')
      expect(c.headers['X-BAPI-SIGN']).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(c)).not.toContain('wallet-read-secret')
    }

    const stored = await query(
      'SELECT external_id,status,amount,amount_minor::text,classification FROM wallet_deposits ORDER BY external_id',
    )
    expect(stored).toEqual([
      expect.objectContaining({
        external_id: 'int-1',
        status: 'success',
        amount_minor: '20000000',
      }),
      expect.objectContaining({ external_id: 'tx-failed:0', status: 'failed' }),
      expect.objectContaining({ external_id: 'tx-own:0', status: 'success', amount: '500.000000' }),
      expect.objectContaining({
        external_id: 'tx-paid:0',
        amount_minor: '125500000',
        classification: 'unclassified',
      }),
      expect.objectContaining({ external_id: 'tx-pending:0', status: 'pending' }),
    ])
    expect(await auditCount('wallet_deposit')).toBe(3)

    // The same answer again: no new rows, no new feed lines.
    expect(await walletTick({ transport })).toMatchObject({ seen: 5, changed: 0 })
    expect(await query('SELECT count(*)::int AS n FROM wallet_deposits')).toEqual([{ n: 5 }])
    expect(await auditCount('wallet_deposit')).toBe(3)

    // The pending deposit is credited: one update, one feed line.
    state.pages[0]![1] = onchain('tx-pending', '40', 3, 1)
    expect(await walletTick({ transport })).toMatchObject({ changed: 1 })
    expect(await auditCount('wallet_deposit')).toBe(4)

    const session = await attemptLogin('test-owner-password-at-least-20', '127.0.0.1')
    const ids = Object.fromEntries(
      (await query('SELECT id,external_id FROM wallet_deposits')).map((r) => [r.external_id, r.id]),
    )
    // Nothing is income before the owner says so.
    let view = (await get<OfficeWallet>('/api/office/wallet', session)).json
    expect(view.periods.today.income).toEqual([])
    expect(view.periods.today.unclassified).toEqual([{ coin: 'USDT', amount: '685.5' }])
    expect(view.unclassifiedCount).toBe(4)
    expect(view).toMatchObject({
      keyConfigured: true,
      keyStatus: 'read_only',
      address: { network: 'TRC20', address: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' },
    })
    expect(view.recent.find((d) => d.source === 'internal')!.from).toBe('client@example.com')

    // Owner only, and only for credited deposits.
    const path = (key: string) => `/api/office/wallet/deposits/${ids[key]}`
    expect((await post(path('tx-paid:0'), { classification: 'income' })).status).toBe(401)
    expect(
      (await post(path('tx-failed:0'), { classification: 'income' }, session)).json,
    ).toMatchObject({ statusMessage: 'WALLET_DEPOSIT_NOT_FINAL' })
    expect((await post(path('tx-paid:0'), { classification: 'profit' }, session)).status).toBe(400)
    expect(
      (await post('/api/office/wallet/deposits/not-a-uuid', { classification: 'income' }, session))
        .status,
    ).toBe(404)
    for (const [key, classification] of [
      ['tx-paid:0', 'income'],
      ['int-1', 'income'],
      ['tx-own:0', 'not_income'],
    ] as const)
      expect((await post(path(key), { classification }, session)).status).toBe(200)
    // Repeating a decision is a no-op and is not audited again.
    expect(
      (await post(path('tx-paid:0'), { classification: 'income' }, session)).json,
    ).toMatchObject({
      changed: false,
    })
    expect(await auditCount('wallet_deposit_classified')).toBe(3)

    view = (await get<OfficeWallet>('/api/office/wallet', session)).json
    expect(view.periods.today).toEqual({
      income: [{ coin: 'USDT', amount: '145.5' }],
      unclassified: [{ coin: 'USDT', amount: '40' }],
      notIncome: [{ coin: 'USDT', amount: '500' }],
    })
    expect(view.periods.all.income).toEqual([{ coin: 'USDT', amount: '145.5' }])

    // The income overview shows it apart from rubles: real orders stay at zero.
    const overview = (await get<OfficeIncome>('/api/office/income', session)).json
    expect(overview.allTime.realOrdersKopecks).toBe(0)
    expect(overview.wallet.periods.month.income).toEqual([{ coin: 'USDT', amount: '145.5' }])
    expect(overview.sources.find((s) => s.id === 'wallet')).toMatchObject({
      status: 'autonomous',
      mode: 'live',
      result: { unit: 'USDT', value: '145.5', test: false },
    })
    expect(overview.needsHuman.map((n) => n.id)).toContain('wallet-classify')
    expect(overview.needsHuman.map((n) => n.id)).not.toContain('wallet-key')
    expect(overview.needsHuman.map((n) => n.id)).not.toContain('wallet-address')
    expect(
      overview.feed.some((f) => /Поступление на кошелёк Bybit: 125\.5 USDT/.test(f.text)),
    ).toBe(true)

    // A later sync keeps the owner's decisions.
    await walletTick({ transport })
    expect(
      (await query("SELECT classification FROM wallet_deposits WHERE external_id='tx-paid:0'"))[0],
    ).toEqual({ classification: 'income' })
  })

  it('refuses a key with write permissions and reads nothing', async () => {
    const { transport, calls } = bybit({
      readOnly: 0,
      pages: [[onchain('tx', '1', 3)]],
      internal: [],
    })
    await expect(walletTick({ transport })).rejects.toThrow('WALLET_KEY_NOT_READ_ONLY')
    expect(calls.map((c) => c.path)).toEqual(['/v5/user/query-api'])
    expect(await query('SELECT count(*)::int AS n FROM wallet_deposits')).toEqual([{ n: 0 }])
    expect(await query('SELECT key_status,key_error FROM wallet_sync')).toEqual([
      { key_status: 'rejected', key_error: 'WALLET_KEY_NOT_READ_ONLY' },
    ])
    expect(await auditCount('wallet_key_rejected')).toBe(1)
    await expect(walletTick({ transport })).rejects.toThrow('WALLET_KEY_NOT_READ_ONLY')
    expect(await auditCount('wallet_key_rejected')).toBe(1)

    const session = await attemptLogin('test-owner-password-at-least-20', '127.0.0.1')
    const overview = (await get<OfficeIncome>('/api/office/income', session)).json
    expect(overview.wallet.keyStatus).toBe('rejected')
    expect(overview.needsHuman.find((n) => n.id === 'wallet-key')).toMatchObject({
      severity: 'block',
    })
    expect(overview.sources.find((s) => s.id === 'wallet')!.status).toBe('needs_human')
  })

  it('records a sync error without losing the other rows', async () => {
    const { transport } = bybit({
      readOnly: 1,
      pages: [[onchain('tx-ok', '10', 3), onchain('tx-odd', '1.0000001', 3)]],
      internal: [],
    })
    await expect(walletTick({ transport })).rejects.toThrow('WALLET_AMOUNT_PRECISION')
    expect(await query('SELECT external_id FROM wallet_deposits')).toEqual([
      { external_id: 'tx-ok:0' },
    ])
    expect(await query('SELECT sync_error,synced_at FROM wallet_sync')).toEqual([
      { sync_error: 'WALLET_AMOUNT_PRECISION', synced_at: null },
    ])
  })

  it('reports a Bybit permission error as a code', async () => {
    const transport = (async () =>
      new Response(JSON.stringify({ retCode: 10005, retMsg: 'Permission denied', result: {} }), {
        status: 200,
      })) as unknown as typeof fetch
    await expect(walletTick({ transport })).rejects.toThrow('WALLET_KEY_NO_PERMISSION')
    expect(await query('SELECT key_status,key_error FROM wallet_sync')).toEqual([
      { key_status: 'error', key_error: 'WALLET_KEY_NO_PERMISSION' },
    ])
  })
})
