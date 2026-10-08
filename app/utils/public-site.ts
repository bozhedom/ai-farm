// Helpers for the public buyer pages. Browser storage is a convenience only: every read and
// write may fail (private window, blocked storage) and the pages work without it.

export type SavedOrder = { token: string; name: string; at: string }
const storageKey = 'ai-farm:orders'
const tokenPattern = /^[A-Za-z0-9_-]{43}$/

export function savedOrders(): SavedOrder[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]')
    return Array.isArray(value)
      ? value
          .filter(
            (o) =>
              o &&
              typeof o.token === 'string' &&
              tokenPattern.test(o.token) &&
              typeof o.name === 'string',
          )
          .slice(0, 5)
      : []
  } catch {
    return []
  }
}

export function rememberOrder(order: SavedOrder) {
  try {
    const rest = savedOrders().filter((o) => o.token !== order.token)
    localStorage.setItem(storageKey, JSON.stringify([order, ...rest].slice(0, 5)))
  } catch {
    // Storage is optional; the link on screen is enough.
  }
}

/** Extracts the order token from a pasted link or a bare token. */
export function tokenFromLink(value: string) {
  const token = value.trim().split(/[/?#]/).filter(Boolean).pop() || ''
  return tokenPattern.test(token) ? token : null
}

const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
/** "сегодня, 11:02", "вчера, 18:40", "8 окт, 13:04". Local time, no seconds, no current year. */
export function publicWhen(iso: string | null | undefined, now = new Date()) {
  if (!iso) return ''
  const d = new Date(iso)
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (day === today) return `сегодня, ${time}`
  if (today - day === 86400000) return `вчера, ${time}`
  const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`
  return `${d.getDate()} ${months[d.getMonth()]}${year}, ${time}`
}

/** Error code from a failed $fetch call, or null. */
export function publicErrorCode(error: unknown): string | null {
  const e = error as { data?: { statusMessage?: string }; statusMessage?: string } | null
  const code = e?.data?.statusMessage || e?.statusMessage
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(code) ? code : null
}

export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
