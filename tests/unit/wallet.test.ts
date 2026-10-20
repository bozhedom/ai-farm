import { describe, expect, it } from 'vitest'
import {
  coinDecimals,
  fromMinor,
  internalStatus,
  onchainStatus,
  parseInternal,
  parseOnchain,
  toMinor,
  walletPeriods,
  type WalletDayRow,
} from '../../core/wallet/math'
import { assertReadOnly } from '../../core/wallet/bybit'
import { validPaymentAddress } from '../../core/config'

const onchain = (patch: Record<string, unknown> = {}) => ({
  id: '1001',
  coin: 'USDT',
  chain: 'TRX',
  amount: '125.5',
  txID: 'abc123',
  status: 3,
  toAddress: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
  tag: '',
  depositFee: '',
  successAt: '1792000000000',
  confirmations: '20',
  txIndex: '0',
  blockHash: 'ff',
  batchReleaseLimit: '-1',
  depositType: '0',
  ...patch,
})

describe('wallet amounts', () => {
  it('stores USDT as exact integer micro-units', () => {
    expect(coinDecimals('USDT')).toBe(6)
    expect(toMinor('125.5', 6)).toBe(125_500_000n)
    expect(toMinor('0.000001', 6)).toBe(1n)
    expect(toMinor('100.00000000', 6)).toBe(100_000_000n)
    expect(toMinor('7', 0)).toBe(7n)
    expect(fromMinor(125_500_000n, 6)).toBe('125.5')
    expect(fromMinor(1n, 6)).toBe('0.000001')
    expect(fromMinor(100_000_000n, 6)).toBe('100')
    // No rounding: a digit past the coin precision is refused, never dropped.
    expect(() => toMinor('1.0000001', 6)).toThrow('WALLET_AMOUNT_PRECISION')
    for (const bad of ['-1', '1e3', '1,5', '', ' 1', '0x10'])
      expect(() => toMinor(bad, 6)).toThrow('WALLET_AMOUNT_INVALID')
    // A long sum stays exact.
    const many = Array.from({ length: 1000 }, () => toMinor('0.1', 6)).reduce((a, b) => a + b)
    expect(fromMinor(many, 6)).toBe('100')
  })
})

describe('Bybit deposit rows', () => {
  it('maps statuses: only 3 (on-chain) and 2 (internal) are success', () => {
    expect([0, 1, 2, 3, 4, 10011, 10012].map(onchainStatus)).toEqual([
      'pending',
      'pending',
      'pending',
      'success',
      'failed',
      'pending',
      'pending',
    ])
    expect([1, 2, 3].map(internalStatus)).toEqual(['pending', 'success', 'failed'])
  })

  it('parses an on-chain deposit with a stable id and minimal raw fields', () => {
    const r = parseOnchain(onchain())!
    expect(r).toMatchObject({
      source: 'onchain',
      externalId: 'abc123:0',
      coin: 'USDT',
      chain: 'TRX',
      amount: '125.5',
      minor: 125_500_000n,
      decimals: 6,
      status: 'success',
      rawStatus: 3,
    })
    expect(r.successAt!.toISOString()).toBe(new Date(1792000000000).toISOString())
    expect(Object.keys(r.raw).sort()).toEqual([
      'bybitId',
      'depositFee',
      'depositType',
      'tag',
      'toAddress',
    ])
    // Pending without a transaction id: not stored yet.
    expect(parseOnchain(onchain({ txID: '', status: 1 }))).toBeNull()
    // Success without a time is not final for us.
    expect(parseOnchain(onchain({ successAt: '' }))!.status).toBe('pending')
    expect(parseOnchain(onchain({ status: 4 }))!).toMatchObject({
      status: 'failed',
      successAt: null,
    })
    expect(parseOnchain(onchain({ coin: 'usdt', txIndex: '2' }))!.externalId).toBe('abc123:2')
    expect(() => parseOnchain(onchain({ amount: 12.5 }))).toThrow('WALLET_RESPONSE_INVALID')
    expect(() => parseOnchain(onchain({ coin: 'U$DT' }))).toThrow('WALLET_RESPONSE_INVALID')
  })

  it('parses an internal Bybit transfer with its sender', () => {
    const r = parseInternal({
      id: '9001',
      type: 1,
      coin: 'USDT',
      amount: '50',
      status: 2,
      address: 'client@example.com',
      createdTime: '1792000000',
      txID: '',
    })!
    expect(r).toMatchObject({
      source: 'internal',
      externalId: '9001',
      chain: 'Bybit',
      minor: 50_000_000n,
      status: 'success',
      raw: { from: 'client@example.com' },
    })
    expect(r.successAt!.getTime()).toBe(1792000000 * 1000)
  })
})

describe('wallet totals', () => {
  const now = new Date('2026-10-20T12:00:00Z')
  const row = (
    day: string,
    classification: WalletDayRow['classification'],
    amount: string,
    coin = 'USDT',
  ): WalletDayRow => ({
    coin,
    decimals: coinDecimals(coin),
    classification,
    day,
    minor: toMinor(amount, coinDecimals(coin)),
  })

  it('counts only "income" as income and keeps the other classes apart, per coin', () => {
    const p = walletPeriods(
      [
        row('2026-10-20', 'income', '100.5'),
        row('2026-10-20', 'unclassified', '40'),
        row('2026-10-18', 'income', '0.25'),
        row('2026-10-10', 'not_income', '500'),
        row('2026-09-01', 'income', '1000'),
        row('2026-10-19', 'income', '0.001', 'BTC'),
      ],
      now,
    )
    expect(p.today).toEqual({
      income: [{ coin: 'USDT', amount: '100.5' }],
      unclassified: [{ coin: 'USDT', amount: '40' }],
      notIncome: [],
    })
    expect(p.week.income).toEqual([
      { coin: 'USDT', amount: '100.75' },
      { coin: 'BTC', amount: '0.001' },
    ])
    expect(p.week.notIncome).toEqual([])
    expect(p.month.notIncome).toEqual([{ coin: 'USDT', amount: '500' }])
    expect(p.month.income[0]).toEqual({ coin: 'USDT', amount: '100.75' })
    expect(p.all.income[0]).toEqual({ coin: 'USDT', amount: '1100.75' })
  })
})

describe('wallet key and address', () => {
  it('accepts only a read-only key without withdrawal rights', () => {
    expect(() => assertReadOnly({ readOnly: 1, permissions: { Wallet: [] } })).not.toThrow()
    expect(() => assertReadOnly({ readOnly: 0, permissions: {} })).toThrow(
      'WALLET_KEY_NOT_READ_ONLY',
    )
    expect(() => assertReadOnly({ readOnly: 1, permissions: { Wallet: ['Withdraw'] } })).toThrow(
      'WALLET_KEY_NOT_READ_ONLY',
    )
  })

  it('checks the address format loosely per network', () => {
    expect(validPaymentAddress('TRC20', 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf')).toBe(true)
    expect(validPaymentAddress('TRC20', '0x52908400098527886E0F7030069857D2E4169EE7')).toBe(false)
    expect(validPaymentAddress('ERC20', '0x52908400098527886E0F7030069857D2E4169EE7')).toBe(true)
    expect(validPaymentAddress('BEP20', '0x0000000000000000000000000000000000000000')).toBe(false)
    expect(validPaymentAddress('TON', 'EQD2NmD_lH5f5u1Kj3KfGyTvhZSX0Eg6qp2a5IQUKXxOG21n')).toBe(
      true,
    )
    expect(validPaymentAddress('TON', 'EQD2NmD')).toBe(false)
    expect(validPaymentAddress('SOL', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV')).toBe(true)
  })
})
