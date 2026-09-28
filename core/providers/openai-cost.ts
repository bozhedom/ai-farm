// Standard, short-context GPT-6 Astra tariff checked 2026-09-28.
// https://developers.openai.com/api/docs/models/gpt-6-astra
// Amounts are integer microdollars ($1 = 1,000,000). Round upward once per call.
export function openaiCost(input: number, output: number, cached = 0, writes = 0) {
  for (const n of [input, output, cached, writes])
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('OPENAI_USAGE_INVALID')
  if (cached + writes > input || input > 100000 || output > 2800)
    throw new Error('OPENAI_USAGE_INVALID')
  const tenths =
    BigInt(input - cached - writes) * 100n +
    BigInt(cached) * 10n +
    BigInt(writes) * 125n +
    BigInt(output) * 500n
  return Number((tenths + 9n) / 10n)
}

export function openaiMaximum(input: number, output: number) {
  // Budget assumes every input token may be a cache write at the higher 1.25x rate.
  return openaiCost(input, output, 0, input)
}

export function usdToKopecks(microusd: number, kopecksPerDollar: number) {
  return Number((BigInt(microusd) * BigInt(kopecksPerDollar) + 999999n) / 1000000n)
}
