import type { ModelPricing } from '../agent-profiles'
// Standard, short-context GPT-6 Astra tariff checked 2026-09-28.
// https://developers.openai.com/api/docs/models/gpt-6-astra
// Amounts are integer microdollars ($1 = 1,000,000). Round upward once per call.
export function openaiCost(
  input: number,
  output: number,
  cached = 0,
  writes = 0,
  pricing?: ModelPricing,
) {
  for (const n of [input, output, cached, writes])
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('OPENAI_USAGE_INVALID')
  if (cached + writes > input || input > 100000 || output > 2800)
    throw new Error('OPENAI_USAGE_INVALID')
  if (pricing) {
    // No cache discount assumed; cache writes retain the conservative 1.25x envelope.
    const writeNano4 =
      BigInt(pricing.cacheWriteNano ?? 0) * 4n > BigInt(pricing.inputNano) * 5n
        ? BigInt(pricing.cacheWriteNano!) * 4n
        : BigInt(pricing.inputNano) * 5n
    const nanos4 =
      BigInt(input - writes) * BigInt(pricing.inputNano) * 4n +
      BigInt(writes) * writeNano4 +
      BigInt(output) * BigInt(pricing.outputNano) * 4n
    const result = (nanos4 + 3999n) / 4000n
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MODEL_PRICE_TOO_HIGH')
    return Number(result)
  }
  const tenths =
    BigInt(input - cached - writes) * 100n +
    BigInt(cached) * 10n +
    BigInt(writes) * 125n +
    BigInt(output) * 500n
  return Number((tenths + 9n) / 10n)
}

export function openaiMaximum(input: number, output: number, pricing?: ModelPricing) {
  // Budget assumes every input token may be a cache write at the higher 1.25x rate.
  return openaiCost(input, output, 0, input, pricing)
}

export function usdToKopecks(microusd: number, kopecksPerDollar: number) {
  return Number((BigInt(microusd) * BigInt(kopecksPerDollar) + 999999n) / 1000000n)
}
