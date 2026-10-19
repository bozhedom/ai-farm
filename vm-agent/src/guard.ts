import { lookup } from 'node:dns/promises'

/**
 * Network guard of the VM browser. Only public http(s) targets are reachable: loopback, private
 * ranges, link-local, carrier NAT, multicast, the cloud metadata address and local-only names
 * are refused by name and again by every resolved address. No other scheme is ever opened.
 */
export function isPrivateIp(ip: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (!v6.includes(':')) return true
  if (v6 === '::' || v6 === '::1') return true
  if (/^fe[89ab][0-9a-f]:/.test(v6) || /^f[cd][0-9a-f]{2}:/.test(v6)) return true
  if (/^ff/.test(v6)) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
  if (mapped) return isPrivateIp(mapped[1]!)
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6)
  if (hex) {
    const hi = parseInt(hex[1]!, 16)
    const lo = parseInt(hex[2]!, 16)
    return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  return false
}

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true
  if (h === 'metadata.google.internal' || h === 'metadata') return true
  if (/^[0-9.]+$/.test(h) || h.includes(':')) return isPrivateIp(h)
  // Single-label names resolve inside the VM's own network only.
  return !h.includes('.')
}

export type Resolver = (hostname: string) => Promise<string[]>
const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)

const cache = new Map<string, { addresses: string[]; at: number }>()
const CACHE_MS = 60_000

/**
 * Whether the browser may request this URL. Non-http(s) schemes, credentials in the URL,
 * blocked names and any private resolved address refuse the request. A name that does not
 * resolve is refused too: the browser would only fail later anyway.
 */
export async function targetAllowed(
  url: string,
  resolver: Resolver = defaultResolver,
  now = Date.now(),
): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false
  if (parsed.username || parsed.password) return false
  const host = parsed.hostname
  if (isBlockedHostname(host)) return false
  if (/^[0-9.]+$/.test(host) || host.startsWith('[')) return true
  let entry = cache.get(host)
  if (!entry || now - entry.at > CACHE_MS) {
    try {
      entry = { addresses: await resolver(host), at: now }
    } catch {
      return false
    }
    cache.set(host, entry)
    if (cache.size > 2000) cache.delete(cache.keys().next().value!)
  }
  return entry.addresses.length > 0 && entry.addresses.every((ip) => !isPrivateIp(ip))
}

/** Tests reset the resolver cache between cases. */
export function clearTargetCache() {
  cache.clear()
}
