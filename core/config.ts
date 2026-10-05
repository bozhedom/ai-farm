import { z } from 'zod'

const flag = z.enum(['true', 'false']).transform((v) => v === 'true')
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback)
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ORIGIN: z.url().default('http://localhost:3210'),
  OWNER_PASSWORD: z.string().min(20),
  SESSION_SECRET: z.string().min(40),
  SECURE_COOKIE: flag.default(false),
  MODEL_PROVIDER: z.enum(['demo', 'yandex', 'ollama', 'openai', 'openrouter']).default('demo'),
  SEARCH_PROVIDER: z.enum(['demo', 'yandex', 'searxng']).default('demo'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.literal('gpt-6-astra').default('gpt-6-astra'),
  OPENAI_TOTAL_BUDGET_MICROUSD: z.coerce.number().int().min(0).max(1000000000).default(1000000),
  OPENAI_USD_KOPECKS: positive(12000).refine((n) => n <= 1000000),
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_MODEL: z.string().default('openrouter/free'),
  OLLAMA_URL: z.url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z
    .string()
    .regex(/^[a-zA-Z0-9._:/-]+$/)
    .default('qwen3:4b'),
  OLLAMA_TIMEOUT_MS: positive(300000).refine((n) => n <= 600000),
  SEARXNG_URL: z.url().default('http://127.0.0.1:8088'),
  YANDEX_API_KEY: z.string().default(''),
  YANDEX_FOLDER_ID: z.string().default(''),
  YANDEX_MODEL: z.string().default('yandexgpt/latest'),
  MODEL_INPUT_KOPECKS_PER_1K: positive(100),
  MODEL_OUTPUT_KOPECKS_PER_1K: positive(100),
  SEARCH_COST_KOPECKS: positive(60),
  PAYMENT_MODE: z.enum(['sandbox', 'sepolia']).default('sandbox'),
  SEPOLIA_RPC_URL: z.string().default(''),
  SEPOLIA_RECEIVER: z.string().default(''),
  SEPOLIA_CONFIRMATIONS: positive(3).refine((n) => n >= 3 && n <= 64),
  MONTHLY_BUDGET_KOPECKS: positive(300000),
  DAILY_BUDGET_KOPECKS: positive(15000),
  ORDER_RESERVE_KOPECKS: positive(4000),
  RESEARCH_RESERVE_KOPECKS: positive(10000),
  AUTONOMY_ENABLED: flag.default(true),
  POLL_INTERVAL_MS: positive(5000),
})

export type Config = z.infer<typeof schema>
let cached: Config | undefined
export function config(): Config {
  if (cached) return cached
  const c = schema.parse(process.env)
  if ((c.MODEL_PROVIDER === 'demo') !== (c.SEARCH_PROVIDER === 'demo'))
    throw new Error('DEMO_PROVIDERS_MUST_MATCH')
  if (c.MODEL_PROVIDER === 'openai' && !c.OPENAI_API_KEY)
    throw new Error('OPENAI_CREDENTIALS_REQUIRED')
  if (c.MODEL_PROVIDER === 'openrouter') {
    if (!c.OPENROUTER_API_KEY) throw new Error('OPENROUTER_CREDENTIALS_REQUIRED')
    if (!isFreeOpenrouterModel(c.OPENROUTER_MODEL))
      throw new Error('OPENROUTER_FREE_MODEL_REQUIRED')
  }
  if (
    (c.MODEL_PROVIDER === 'yandex' || c.SEARCH_PROVIDER === 'yandex') &&
    (!c.YANDEX_API_KEY || !c.YANDEX_FOLDER_ID)
  )
    throw new Error('YANDEX_CREDENTIALS_REQUIRED')
  for (const endpoint of [c.OLLAMA_URL, c.SEARXNG_URL]) {
    const u = new URL(endpoint)
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/'
    )
      throw new Error('INVALID_LOCAL_PROVIDER_URL')
  }
  if (c.PAYMENT_MODE === 'sepolia') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(c.SEPOLIA_RECEIVER) || /^0x0{40}$/.test(c.SEPOLIA_RECEIVER))
      throw new Error('SEPOLIA_RECEIVER_REQUIRED')
    if (!c.SEPOLIA_RPC_URL.startsWith('https://')) throw new Error('HTTPS_RPC_REQUIRED')
  }
  if (new URL(c.APP_ORIGIN).protocol === 'https:' && !c.SECURE_COOKIE)
    throw new Error('HTTPS_REQUIRES_SECURE_COOKIE')
  cached = c
  return c
}

export function isFreeOpenrouterModel(model: string) {
  return (
    model === 'openrouter/free' ||
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*:free$/.test(model)
  )
}
