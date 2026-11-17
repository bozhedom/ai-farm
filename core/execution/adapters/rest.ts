import { createHmac } from 'node:crypto'
import type { ExecutionExchange } from '../types'

export type RestMode = 'demo' | 'live'
export type RestKind = 'futures' | 'spot' | 'sapi'
export type RestCredentials = { key: string; secret: string; passphrase?: string }
export type BuiltRequest = {
  url: string
  method: 'GET' | 'POST' | 'DELETE'
  headers: Record<string, string>
  body?: string
}

export function venueOrigin(
  exchange: ExecutionExchange,
  mode: RestMode,
  kind: RestKind = 'futures',
) {
  if (exchange === 'bybit')
    return mode === 'demo' ? 'https://api-demo.bybit.com' : 'https://api.bybit.com'
  if (exchange === 'okx') return 'https://www.okx.com'
  if (exchange === 'binance') {
    if (kind === 'futures')
      return mode === 'demo' ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com'
    return mode === 'demo' ? 'https://testnet.binance.vision' : 'https://api.binance.com'
  }
  return 'https://api.bitget.com'
}

export function compactSymbol(symbol: string) {
  if (!/^[A-Z0-9]{1,32}-USDT$/.test(symbol) || symbol === 'USDT-USDT')
    throw new Error('EXECUTION_SYMBOL_INVALID')
  return symbol.replace('-', '')
}

export function okxSpotSymbol(symbol: string) {
  compactSymbol(symbol)
  return symbol
}

export function okxSwapSymbol(symbol: string) {
  return `${okxSpotSymbol(symbol)}-SWAP`
}

export function tradingSymbolFromCompact(code: string) {
  if (!code.endsWith('USDT') || code.length <= 4) throw new Error('EXECUTION_SYMBOL_INVALID')
  const symbol = `${code.slice(0, -4)}-USDT`
  if (compactSymbol(symbol) !== code) throw new Error('EXECUTION_SYMBOL_INVALID')
  return symbol
}

export function signBybit(
  secret: string,
  timestamp: string,
  key: string,
  recvWindow: string,
  payload: string,
) {
  return createHmac('sha256', secret)
    .update(timestamp + key + recvWindow + payload)
    .digest('hex')
}

export function signOkx(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string,
) {
  return createHmac('sha256', secret)
    .update(timestamp + method + path + body)
    .digest('base64')
}

export function signBinance(secret: string, query: string) {
  return createHmac('sha256', secret).update(query).digest('hex')
}

export function signBitget(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string,
) {
  return createHmac('sha256', secret)
    .update(timestamp + method + path + body)
    .digest('base64')
}

export function assertLiveWrite(mode: RestMode, liveEnabled?: boolean) {
  if (mode === 'live' && !liveEnabled) throw new Error('EXECUTION_LIVE_DISABLED')
}

export function buildRequest(p: {
  exchange: ExecutionExchange
  mode: RestMode
  kind?: RestKind
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  query?: Record<string, string>
  body?: Record<string, unknown>
  credentials?: RestCredentials
  signed?: boolean
  now: number
  recvWindow?: string
}): BuiltRequest {
  const kind = p.kind || 'futures'
  const origin = venueOrigin(p.exchange, p.mode, kind)
  const method = p.method
  const query = new URLSearchParams(p.query || {})
  const jsonBody =
    p.body && method !== 'GET' && p.exchange !== 'binance' ? JSON.stringify(p.body) : ''
  if (p.signed) {
    const credentials = p.credentials
    if (!credentials?.key || !credentials.secret) throw new Error('EXECUTION_CREDENTIALS_REQUIRED')
    if (['okx', 'bitget'].includes(p.exchange) && !credentials.passphrase)
      throw new Error('EXECUTION_CREDENTIALS_REQUIRED')
    if (p.exchange === 'bybit') {
      const timestamp = String(p.now)
      const recvWindow = p.recvWindow || '5000'
      const payload = jsonBody || query.toString()
      return {
        url: `${origin}${p.path}${query.toString() ? `?${query}` : ''}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-BAPI-API-KEY': credentials.key,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'X-BAPI-SIGN': signBybit(
            credentials.secret,
            timestamp,
            credentials.key,
            recvWindow,
            payload,
          ),
        },
        body: jsonBody || undefined,
      }
    }
    if (p.exchange === 'okx') {
      const timestamp = new Date(p.now).toISOString()
      const path = `${p.path}${query.toString() ? `?${query}` : ''}`
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'OK-ACCESS-KEY': credentials.key,
        'OK-ACCESS-PASSPHRASE': credentials.passphrase || '',
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-SIGN': signOkx(credentials.secret, timestamp, method, path, jsonBody),
      }
      if (p.mode === 'demo') headers['x-simulated-trading'] = '1'
      return { url: `${origin}${path}`, method, headers, body: jsonBody || undefined }
    }
    if (p.exchange === 'binance') {
      const params = new URLSearchParams(p.query || {})
      if (p.body) {
        for (const [key, value] of Object.entries(p.body)) params.set(key, String(value))
      }
      params.set('timestamp', String(p.now))
      params.set('recvWindow', p.recvWindow || '5000')
      const unsigned = params.toString()
      const signature = signBinance(credentials.secret, unsigned)
      const encoded = `${unsigned}&signature=${signature}`
      const headers: Record<string, string> = { 'X-MBX-APIKEY': credentials.key }
      if (method === 'GET' || method === 'DELETE') {
        return { url: `${origin}${p.path}?${encoded}`, method, headers }
      }
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      return { url: `${origin}${p.path}`, method, headers, body: encoded }
    }
    const timestamp = String(p.now)
    const path = `${p.path}${query.toString() ? `?${query}` : ''}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      locale: 'en-US',
      'ACCESS-KEY': credentials.key,
      'ACCESS-PASSPHRASE': credentials.passphrase || '',
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-SIGN': signBitget(credentials.secret, timestamp, method, path, jsonBody),
    }
    if (p.mode === 'demo') headers.paptrading = '1'
    return { url: `${origin}${path}`, method, headers, body: jsonBody || undefined }
  }
  const path = `${p.path}${query.toString() ? `?${query}` : ''}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (jsonBody) headers['Content-Type'] = 'application/json'
  if (p.exchange === 'okx' && p.mode === 'demo') headers['x-simulated-trading'] = '1'
  if (p.exchange === 'bitget' && p.mode === 'demo') headers.paptrading = '1'
  return { url: `${origin}${path}`, method, headers, body: jsonBody || undefined }
}

export async function sendRequest(
  built: BuiltRequest,
  fetchImpl: typeof fetch,
  timeoutMs = 7000,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new Error('EXECUTION_NETWORK_UNAVAILABLE')
  }
  if (response.status === 429) throw new Error('EXECUTION_RATE_LIMIT')
  if ([403, 451].includes(response.status)) throw new Error('EXECUTION_REGION_UNAVAILABLE')
  if (!response.ok) throw new Error('EXECUTION_NETWORK_UNAVAILABLE')
  try {
    return await response.json()
  } catch {
    throw new Error('EXECUTION_RESPONSE_INVALID')
  }
}

export function requireRetOk(exchange: ExecutionExchange, raw: unknown) {
  if (!raw || typeof raw !== 'object') throw new Error('EXECUTION_RESPONSE_INVALID')
  const row = raw as Record<string, unknown>
  if (exchange === 'bybit') {
    if (typeof row.retCode !== 'number') throw new Error('EXECUTION_RESPONSE_INVALID')
    if (row.retCode) throw new Error('EXECUTION_EXCHANGE_API_ERROR')
    return row.result
  }
  if (exchange === 'okx') {
    if (row.code !== '0') throw new Error('EXECUTION_EXCHANGE_API_ERROR')
    return row.data
  }
  if (exchange === 'bitget') {
    if (row.code !== '00000') throw new Error('EXECUTION_EXCHANGE_API_ERROR')
    return row.data
  }
  if (row.code !== undefined && row.code !== 0 && row.code !== '0')
    throw new Error('EXECUTION_EXCHANGE_API_ERROR')
  return raw
}

export function alreadyConfigured(exchange: ExecutionExchange, raw: unknown) {
  if (!raw || typeof raw !== 'object') return false
  const row = raw as Record<string, unknown>
  const code = String(row.retCode ?? row.code ?? '')
  const message = String(row.retMsg ?? row.msg ?? row.message ?? '').toLowerCase()
  if (
    exchange === 'binance' &&
    (code === '-4046' || message.includes('no need to change margin type'))
  )
    return true
  if (
    message.includes('isolated') &&
    (message.includes('already') || message.includes('not modified'))
  )
    return true
  return false
}
