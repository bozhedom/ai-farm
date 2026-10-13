import { z } from 'zod'
import { EXECUTION_POLICY as P } from '../policy'
import { units, SCALE } from '../trading/decimal'

let cached: { apyBps: number; observedAt: number } | null = null
/** Paper estimates only; real interest always comes from the dedicated aToken balance. */
export async function paperAaveYield() {
  if (cached && Date.now() - cached.observedAt < P.defiYieldMaxAgeMs / 2) return cached
  const response = await fetch('https://yields.llama.fi/pools', {
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) throw new Error('EXECUTION_YIELD_UNAVAILABLE')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('EXECUTION_YIELD_UNAVAILABLE')
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > 20 * 1024 * 1024) {
      await reader.cancel()
      throw new Error('EXECUTION_YIELD_UNAVAILABLE')
    }
    chunks.push(value)
  }
  const parsed = z
    .object({ data: z.array(z.unknown()).max(30000) })
    .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  const schema = z.object({
    project: z.literal('aave-v3'),
    chain: z.literal('Ethereum'),
    symbol: z.literal('USDC'),
    apyBase: z.number().finite().min(0).max(50),
    tvlUsd: z.number().finite().min(1000000),
    stablecoin: z.literal(true),
  })
  for (const raw of parsed.data) {
    const row = schema.safeParse(raw)
    if (!row.success) continue
    const apyBps = Number((units(row.data.apyBase.toFixed(6)) * 100n) / SCALE)
    cached = { apyBps, observedAt: Date.now() }
    return cached
  }
  throw new Error('EXECUTION_YIELD_UNAVAILABLE')
}
