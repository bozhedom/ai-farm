import type {
  IncomeAmount,
  IncomeExchange,
  IncomeMode,
  IncomeSource,
  IncomeSourceStatus,
} from '../../../core/contracts/overview'
import type {
  WalletAmount,
  WalletClassification,
  WalletDeposit,
  WalletKeyStatus,
} from '../../../core/contracts/wallet'
import type { Badge } from './labels'
import { groupDigits } from './format'

/** Labels and exact formatting for the income overview. */

export const sourceStatus: Record<IncomeSourceStatus, Badge> = {
  autonomous: { label: 'Работает сам', tone: 'ok' },
  needs_human: { label: 'Нужен человек', tone: 'human' },
  paper_only: { label: 'Только тренировка', tone: 'test' },
  disabled: { label: 'Выключено', tone: 'off' },
}

export const incomeMode: Record<IncomeMode | 'test', Badge> = {
  paper: { label: 'Тренировка', tone: 'test' },
  demo: { label: 'Тест биржи', tone: 'test' },
  live: { label: 'Реальные деньги', tone: 'sun' },
  test: { label: 'Тестовая оплата', tone: 'test' },
}

export const exchangeTitle: Record<IncomeExchange, string> = {
  okx: 'OKX',
  bybit: 'Bybit',
  binance: 'Binance',
  bitget: 'Bitget',
}

/** Series colours from the design tokens, so both themes work. */
export const exchangeColor: Record<IncomeExchange, string> = {
  okx: 'var(--ink-2)',
  bybit: 'var(--st-wait)',
  binance: 'var(--sky)',
  bitget: 'var(--plum)',
}

/**
 * Exact decimal string -> «1 234,57», rounded half up with bigint arithmetic. `signed` adds «+»
 * to positive values. The minus is a real minus sign.
 */
export function decimalText(value: string | null | undefined, digits = 2, signed = false) {
  const text = String(value ?? '0').trim()
  const match = text.match(/^(-?)(\d+)(?:\.(\d+))?$/)
  if (!match) return '0'
  const negative = match[1] === '-'
  const fraction = (match[3] ?? '').padEnd(digits + 1, '0')
  const scale = 10n ** BigInt(digits)
  let scaled = BigInt(match[2]!) * scale + BigInt(fraction.slice(0, digits) || '0')
  if (Number(fraction[digits]) >= 5) scaled += 1n
  const whole = scaled / scale
  const rest = (scaled % scale).toString().padStart(digits, '0')
  const zero = scaled === 0n
  const sign = zero ? '' : negative ? '−' : signed ? '+' : ''
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${sign}${wholeText}${digits ? `,${rest}` : ''}`
}

export const isZeroDecimal = (value: string | null | undefined) =>
  /^-?0*(?:\.0*)?$/.test(String(value ?? '0'))
export const isNegative = (value: string | null | undefined) =>
  String(value ?? '').startsWith('-') && !isZeroDecimal(value)

/** Signed rubles from kopecks: «+1 240 ₽», «−35,10 ₽». */
export function rubSigned(kopecks: number) {
  const rest = Math.abs(kopecks) % 100
  const sign = kopecks > 0 ? '+' : kopecks < 0 ? '−' : ''
  return `${sign}${groupDigits(kopecks / 100)}${rest ? ',' + String(rest).padStart(2, '0') : ''} ₽`
}

export const amountText = (a: IncomeAmount, signed = true) =>
  `${decimalText(a.amount, 2, signed)} ${a.currency}`

export function resultText(result: IncomeSource['result']) {
  if (!result) return '—'
  if (result.unit === 'count') return groupDigits(Number(result.value))
  if (result.unit === 'RUB') return rubSigned(Number(result.value)).replace(/^\+/, '')
  return `${decimalText(result.value, 2, true)} ${result.unit}`
}

/** Display-only number for chart geometry; accounting never reads it. */
export const chartNumber = (value: string) => Number(value) || 0

// ---- Bybit wallet ------------------------------------------------------------------------

export const walletKeyBadge: Record<WalletKeyStatus, Badge> = {
  not_configured: { label: 'Ключ не задан', tone: 'off' },
  unchecked: { label: 'Ключ ждёт проверки', tone: 'wait' },
  read_only: { label: 'Только чтение: проверено', tone: 'ok' },
  rejected: { label: 'Ключ отклонён', tone: 'err' },
  error: { label: 'Ошибка проверки ключа', tone: 'err' },
}

export const depositStatusBadge: Record<WalletDeposit['status'], Badge> = {
  pending: { label: 'Ждёт зачисления', tone: 'wait' },
  success: { label: 'Зачислено', tone: 'ok' },
  failed: { label: 'Не прошло', tone: 'err' },
}

export const classificationBadge: Record<WalletClassification, Badge> = {
  unclassified: { label: 'Не разобрано', tone: 'human' },
  income: { label: 'Доход', tone: 'sun' },
  not_income: { label: 'Не доход', tone: 'off' },
}

/** Exact amount as reported, trailing zeros removed: «1 250,5». */
export function exactAmount(value: string) {
  const [whole = '0', fraction = ''] = value.split('.')
  const rest = fraction.replace(/0+$/, '')
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${rest ? `,${rest}` : ''}`
}

/** «100,50 USDT · 0,0015 BTC», or «0 USDT» when empty. Stablecoins to cents, others exact. */
export const walletAmountsText = (list: WalletAmount[]) =>
  list.length
    ? list
        .map(
          (a) =>
            `${['USDT', 'USDC'].includes(a.coin) ? decimalText(a.amount, 2) : exactAmount(a.amount)} ${a.coin}`,
        )
        .join(' · ')
    : '0 USDT'
