/**
 * Pure rules for Bybit deposits: exact parsing, integer minor units, status mapping and period
 * totals by classification. No floating point and no currency conversion.
 */
import { z } from 'zod'
import type { IncomePeriod } from '../contracts/overview'
import type { WalletAmount, WalletClassification, WalletTotals } from '../contracts/wallet'
import { dayKey, periodStart } from '../income/math'

/** Minor-unit precision per coin. USDT and USDC are stored as integer micro-units. */
const knownDecimals: Record<string, number> = { USDT: 6, USDC: 6, BTC: 8, ETH: 18, TON: 9 }
export const coinDecimals = (coin: string) => knownDecimals[coin] ?? 18

/** Exact decimal string -> integer minor units. Digits beyond `decimals` must be zeros. */
export function toMinor(amount: string, decimals: number): bigint {
  if (!/^\d{1,24}(?:\.\d{1,36})?$/.test(amount)) throw new Error('WALLET_AMOUNT_INVALID')
  const [whole, fraction = ''] = amount.split('.')
  if (/[^0]/.test(fraction.slice(decimals))) throw new Error('WALLET_AMOUNT_PRECISION')
  return (
    BigInt(whole!) * 10n ** BigInt(decimals) +
    BigInt(fraction.slice(0, decimals).padEnd(decimals, '0') || '0')
  )
}

/** Integer minor units -> shortest exact decimal string. */
export function fromMinor(minor: bigint, decimals: number): string {
  const sign = minor < 0n ? '-' : ''
  const n = minor < 0n ? -minor : minor
  if (!decimals) return `${sign}${n}`
  const scale = 10n ** BigInt(decimals)
  const fraction = (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${sign}${n / scale}${fraction ? `.${fraction}` : ''}`
}

export type DepositStatus = 'pending' | 'success' | 'failed'
/** Bybit on-chain depositStatus: 3 success (final), 4 failed; 0, 1, 2, 10011, 10012 still pending. */
export const onchainStatus = (n: number): DepositStatus =>
  n === 3 ? 'success' : n === 4 ? 'failed' : 'pending'
/** Bybit internal deposit status: 1 processing, 2 success, 3 failed. */
export const internalStatus = (n: number): DepositStatus =>
  n === 2 ? 'success' : n === 3 ? 'failed' : 'pending'

export type DepositRecord = {
  source: 'onchain' | 'internal'
  externalId: string
  txId: string
  coin: string
  chain: string
  amount: string
  minor: bigint
  decimals: number
  status: DepositStatus
  rawStatus: number
  confirmations: string
  successAt: Date | null
  raw: Record<string, string>
}

const text = z.union([z.string(), z.number().int().transform(String)]).default('')
const int = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number),
])
const coin = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{1,20}$/))
const amount = z.string().regex(/^\d{1,24}(?:\.\d{1,36})?$/)
const stamp = (value: string, unit: 'ms' | 's') =>
  /^\d{1,16}$/.test(value) && Number(value) > 0
    ? new Date(Number(value) * (unit === 's' ? 1000 : 1))
    : null

const onchainRow = z.object({
  id: text,
  coin,
  chain: text,
  amount,
  txID: text,
  status: int,
  toAddress: text,
  tag: text,
  depositFee: text,
  successAt: text,
  confirmations: text,
  txIndex: text,
  depositType: text,
})
const internalRow = z.object({
  id: text,
  coin,
  amount,
  status: int,
  address: text,
  createdTime: text,
  txID: text,
})
const cut = (s: string, n = 200) => s.slice(0, n)

/** One row of /v5/asset/deposit/query-record. Rows without a transaction id are not stored yet. */
export function parseOnchain(value: unknown): DepositRecord | null {
  const r = onchainRow.safeParse(value)
  if (!r.success) throw new Error('WALLET_RESPONSE_INVALID')
  const row = r.data
  if (!row.txID) return null
  const decimals = coinDecimals(row.coin)
  let status = onchainStatus(row.status)
  const successAt = stamp(row.successAt, 'ms')
  // A success without its time is not final for us yet; the next sync picks it up.
  if (status === 'success' && !successAt) status = 'pending'
  return {
    source: 'onchain',
    externalId: cut(`${row.txID}:${row.txIndex || '0'}`),
    txId: cut(row.txID),
    coin: row.coin,
    chain: cut(row.chain, 40),
    amount: row.amount,
    minor: toMinor(row.amount, decimals),
    decimals,
    status,
    rawStatus: row.status,
    confirmations: cut(row.confirmations, 40),
    successAt: status === 'success' ? successAt : null,
    raw: {
      bybitId: cut(row.id),
      toAddress: cut(row.toAddress),
      tag: cut(row.tag),
      depositFee: cut(row.depositFee, 40),
      depositType: cut(row.depositType, 20),
    },
  }
}

/** One row of /v5/asset/deposit/query-internal-record (a Bybit-to-Bybit transfer). */
export function parseInternal(value: unknown): DepositRecord | null {
  const r = internalRow.safeParse(value)
  if (!r.success) throw new Error('WALLET_RESPONSE_INVALID')
  const row = r.data
  if (!row.id) return null
  const decimals = coinDecimals(row.coin)
  let status = internalStatus(row.status)
  const at = stamp(row.createdTime, 's')
  if (status === 'success' && !at) status = 'pending'
  return {
    source: 'internal',
    externalId: cut(row.id),
    txId: cut(row.txID),
    coin: row.coin,
    chain: 'Bybit',
    amount: row.amount,
    minor: toMinor(row.amount, decimals),
    decimals,
    status,
    rawStatus: row.status,
    confirmations: '',
    successAt: status === 'success' ? at : null,
    raw: { from: cut(row.address) },
  }
}

/** Successful deposits summed per coin, classification and UTC day of success. */
export type WalletDayRow = {
  coin: string
  decimals: number
  classification: WalletClassification
  day: string
  minor: bigint
}

const emptyTotals = () => ({
  income: new Map<string, bigint>(),
  unclassified: new Map<string, bigint>(),
  notIncome: new Map<string, bigint>(),
})
const field: Record<WalletClassification, keyof ReturnType<typeof emptyTotals>> = {
  income: 'income',
  unclassified: 'unclassified',
  not_income: 'notIncome',
}

/** USDT first, then by coin name; zero amounts are left out. */
function amounts(map: Map<string, bigint>, decimals: Map<string, number>): WalletAmount[] {
  return [...map.entries()]
    .filter(([, n]) => n !== 0n)
    .sort(([a], [b]) => (a === 'USDT' ? -1 : b === 'USDT' ? 1 : a.localeCompare(b)))
    .map(([c, n]) => ({ coin: c, amount: fromMinor(n, decimals.get(c) ?? coinDecimals(c)) }))
}

/** Today, 7 and 30 UTC days (as in the income overview) and all time. */
export function walletPeriods(
  rows: WalletDayRow[],
  now: Date,
): Record<IncomePeriod | 'all', WalletTotals> {
  const periods = ['today', 'week', 'month', 'all'] as const
  const decimals = new Map(rows.map((r) => [r.coin, r.decimals]))
  const today = dayKey(now)
  return Object.fromEntries(
    periods.map((period) => {
      const from = period === 'all' ? '' : periodStart(now, period)
      const t = emptyTotals()
      for (const r of rows) {
        if (period !== 'all' && (r.day < from || r.day > today)) continue
        const map = t[field[r.classification]]
        map.set(r.coin, (map.get(r.coin) ?? 0n) + r.minor)
      }
      return [
        period,
        {
          income: amounts(t.income, decimals),
          unclassified: amounts(t.unclassified, decimals),
          notIncome: amounts(t.notIncome, decimals),
        },
      ]
    }),
  ) as Record<IncomePeriod | 'all', WalletTotals>
}
