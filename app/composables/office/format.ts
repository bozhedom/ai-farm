/** Owner office formatting: integer kopecks, short Russian dates, no seconds. */

const nbsp = ' '
const monthsShort = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сент',
  'окт',
  'ноя',
  'дек',
]
const monthsFull = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
]
const weekdays = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']

export function groupDigits(value: number) {
  return String(Math.trunc(Math.abs(value))).replace(/\B(?=(\d{3})+(?!\d))/g, nbsp)
}

/** 124000 -> «1 240 ₽», 410 -> «4,10 ₽». Kopecks stay integers until this point. */
export function rub(kopecks: number | null | undefined) {
  const value = Math.round(Number(kopecks) || 0)
  const rest = Math.abs(value) % 100
  const sign = value < 0 ? '-' : ''
  return `${sign}${groupDigits(value / 100)}${rest ? ',' + String(rest).padStart(2, '0') : ''}${nbsp}₽`
}

export function count(value: number | null | undefined) {
  return groupDigits(Number(value) || 0)
}

/** plural(5, ['идея', 'идеи', 'идей']) -> «идей». */
export function plural(n: number, forms: [string, string, string]) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return forms[2]
  if (b > 1 && b < 5) return forms[1]
  if (b === 1) return forms[0]
  return forms[2]
}

export const withCount = (n: number, forms: [string, string, string]) =>
  `${count(n)} ${plural(n, forms)}`

const pad = (n: number) => String(n).padStart(2, '0')
const valid = (iso: string | null | undefined) => {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

export function time(iso: string | null | undefined) {
  const date = valid(iso)
  return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : ''
}

export function isToday(iso: string | null | undefined, now = new Date()) {
  const date = valid(iso)
  return !!date && sameDay(date, now)
}

/** «8 окт», with the year only when it is not the current one. */
export function day(iso: string | null | undefined, now = new Date()) {
  const date = valid(iso)
  if (!date) return ''
  const base = `${date.getDate()} ${monthsShort[date.getMonth()]}`
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`
}

/** «сегодня, 11:02», «вчера, 18:15», «8 окт, 13:04». */
export function when(iso: string | null | undefined, now = new Date()) {
  const date = valid(iso)
  if (!date) return ''
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(date, now)) return `сегодня, ${time(iso)}`
  if (sameDay(date, yesterday)) return `вчера, ${time(iso)}`
  return `${day(iso, now)}, ${time(iso)}`
}

/** Short day for lists: «сегодня», «вчера», «8 окт». */
export function dayWord(iso: string | null | undefined, now = new Date()) {
  const date = valid(iso)
  if (!date) return ''
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(date, now)) return 'сегодня'
  if (sameDay(date, yesterday)) return 'вчера'
  return day(iso, now)
}

/** «через 20 мин», «сегодня в 14:00», «завтра в 09:00», «10 окт в 09:00». */
export function upcoming(iso: string | null | undefined, now = new Date()) {
  const date = valid(iso)
  if (!date) return ''
  const minutes = Math.round((date.getTime() - now.getTime()) / 60000)
  if (minutes <= 0) return 'сейчас'
  if (minutes < 60) return `через ${minutes} мин`
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (sameDay(date, now)) return `сегодня в ${time(iso)}`
  if (sameDay(date, tomorrow)) return `завтра в ${time(iso)}`
  return `${day(iso, now)} в ${time(iso)}`
}

/** «5 мин назад», «3 ч назад», «2 дня назад». */
export function ago(iso: string | null | undefined, now = new Date()) {
  const date = valid(iso)
  if (!date) return ''
  const minutes = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60000))
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин назад`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ч назад`
  const days = Math.round(hours / 24)
  if (days < 31) return `${days} ${plural(days, ['день', 'дня', 'дней'])} назад`
  return day(iso, now)
}

/** «Среда, 8 октября». */
export function todayTitle(now = new Date()) {
  return `${weekdays[now.getDay()]}, ${now.getDate()} ${monthsFull[now.getMonth()]}`
}

export function domain(url: string | null | undefined) {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Short order number for people: «1042» from orders.number, the id start for old answers. */
export const orderNumber = (order: { id: string; number?: number | null }) =>
  order.number ? String(order.number) : order.id.slice(0, 6).toUpperCase()

/** Splits «Первое предложение. Пояснение.» into a main line and a quiet second line. */
export function splitSentence(text: string) {
  const clean = text.trim()
  const match = clean.match(/^(.{12,180}?[.!?])\s+(\S.*)$/s)
  return match ? { main: match[1]!, rest: match[2]! } : { main: clean, rest: '' }
}

export const percent = (part: number, whole: number) =>
  whole > 0 ? Math.max(0, Math.min(100, Math.round((part / whole) * 100))) : 0
