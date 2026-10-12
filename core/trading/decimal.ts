/** Every financial value uses 18 decimal places. JSON / SQL boundaries use strings. */
export const SCALE = 10n ** 18n
export const BPS = 10_000n

export function units(value: string): bigint {
  if (!/^-?\d{1,24}(?:\.\d{1,36})?$/.test(value)) throw new Error('TRADING_DECIMAL_INVALID')
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  if (/[^0]/.test(fraction.slice(18))) throw new Error('TRADING_PRECISION_UNSUPPORTED')
  const amount = BigInt(whole!) * SCALE + BigInt(fraction.slice(0, 18).padEnd(18, '0'))
  return negative ? -amount : amount
}

export function decimal(value: bigint): string {
  const sign = value < 0n ? '-' : ''
  const n = abs(value)
  const fraction = (n % SCALE).toString().padStart(18, '0').replace(/0+$/, '')
  return `${sign}${n / SCALE}${fraction ? `.${fraction}` : ''}`
}

export const abs = (n: bigint) => (n < 0n ? -n : n)
export const min = (a: bigint, b: bigint) => (a < b ? a : b)
export const max = (a: bigint, b: bigint) => (a > b ? a : b)
export function ceilDiv(n: bigint, d: bigint) {
  if (n < 0n || d <= 0n) throw new Error('TRADING_ARITHMETIC_INVALID')
  return (n + d - 1n) / d
}
export const cost = (qty: bigint, price: bigint) => ceilDiv(qty * price, SCALE)
export const proceeds = (qty: bigint, price: bigint) => (qty * price) / SCALE
export const fee = (n: bigint, bps: number) => ceilDiv(n * BigInt(bps), BPS)
export const floorStep = (n: bigint, step: bigint) => (n / step) * step
export const ceilStep = (n: bigint, step: bigint) => ceilDiv(n, step) * step
export const ratioBps = (n: bigint, d: bigint) => (d > 0n ? Number((n * BPS) / d) : 0)
