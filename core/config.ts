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
  // The same paid model and dollar limits, sent through OpenRouter with OPENROUTER_API_KEY.
  OPENAI_TRANSPORT: z.enum(['openai', 'openrouter']).default('openai'),
  OPENAI_TOTAL_BUDGET_MICROUSD: z.coerce.number().int().min(0).max(1000000000).default(1000000),
  OPENAI_USD_KOPECKS: positive(12000).refine((n) => n <= 1000000),
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_MODEL: z.string().default('openrouter/free'),
  // Reasoning models can spend the whole output limit before the JSON answer.
  OPENROUTER_REASONING_EFFORT: z.enum(['', 'minimal', 'low', 'medium', 'high']).default(''),
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
  // Conditional test rate: whole rubles per 1 test ETH. Not a market rate; test ETH is never revenue.
  TEST_ETH_RUB_RATE: positive(300000).refine((n) => n <= 1000000000),
  // The worker may find Sepolia transfers to SEPOLIA_RECEIVER by scanning new blocks.
  SEPOLIA_SCAN_ENABLED: flag.default(true),
  // Local anvil node that imitates Sepolia (chain 11155111) for tests and demos. Allows plain
  // HTTP to a loopback or compose host only. Never a public network, never real money.
  SEPOLIA_LOCAL_NODE: flag.default(false),
  PUBLIC_SELLER: z.string().trim().max(200).default(''),
  PUBLIC_CONTACT: z.string().trim().max(200).default(''),
  PUBLIC_TERMS_URL: z.string().trim().default(''),
  // Public orders created per UTC day that are still open or paid; expired ones free a slot.
  PUBLIC_ORDERS_PER_DAY: z.coerce.number().int().min(0).max(1000).default(30),
  // Public orders that may be paid (and so spend model budget) per UTC day.
  PUBLIC_PAID_ORDERS_PER_DAY: z.coerce.number().int().min(0).max(1000).default(10),
  // Unpaid public orders one buyer address may hold open at once.
  PUBLIC_OPEN_ORDERS_PER_CLIENT: z.coerce.number().int().min(1).max(20).default(2),
  // Lets an anonymous buyer press the sandbox payment button. Only for a local demo: every such
  // order spends real model budget. Off: the owner confirms sandbox payments in the office.
  PUBLIC_SANDBOX_PAY: flag.default(false),
  // Trust X-Forwarded-For from a reverse proxy on a private address (Caddy in compose.edge.yaml).
  // Off: the socket address is the buyer, and a forwarded header is ignored.
  TRUST_PROXY: flag.default(false),
  PUBLIC_INDEXING: flag.default(false),
  SCOUT_RESERVE_KOPECKS: positive(3000),
  LEAD_RESERVE_KOPECKS: positive(2000),
  REPORT_RESERVE_KOPECKS: positive(2000),
  LEAD_DRAFTS_PER_DAY: z.coerce.number().int().min(0).max(12).default(3),
  IDEA_PRODUCTS_PER_DAY: z.coerce.number().int().min(0).max(12).default(2),
  AUTONOMY_ENABLED: flag.default(true),
  POLL_INTERVAL_MS: positive(5000),
  // Computer use: GPT-6 Astra (paid route through OpenRouter) drives a browser on a separate VM.
  // Needs the office toggle as well. Models never get the VM token; only the worker does.
  COMPUTER_USE_ENABLED: flag.default(false),
  VM_AGENT_URL: z.string().default(''),
  VM_AGENT_TOKEN: z.string().default(''),
  COMPUTER_USE_STEP_LIMIT: positive(30).refine((n) => n <= 200),
  // Integer microdollars ($1 = 1,000,000). The task cap is also the kopeck reserve of the task.
  COMPUTER_USE_TASK_CAP_MICROUSD: positive(2000000).refine((n) => n <= 50000000),
  COMPUTER_USE_DAILY_CAP_MICROUSD: positive(10000000).refine((n) => n <= 500000000),
  COMPUTER_USE_SCREENSHOT_DIR: z.string().trim().min(1).default('output/computer-use'),
  // Separate credentials: a demo request can never fall back to a real account.
  TRADING_LIVE_ENABLED: flag.default(false),
  // The previous text-services experiment remains available with its preserved history.
  WORKSPACE_MODE: z.enum(['trading', 'studio']).default('trading'),
  OKX_API_HOST: z
    .enum(['openapi.okx.com', 'www.okx.com', 'us.okx.com', 'eea.okx.com'])
    .default('openapi.okx.com'),
  OKX_DEMO_API_KEY: z.string().default(''),
  OKX_DEMO_SECRET: z.string().default(''),
  OKX_DEMO_PASSPHRASE: z.string().default(''),
  OKX_LIVE_API_KEY: z.string().default(''),
  OKX_LIVE_SECRET: z.string().default(''),
  OKX_LIVE_PASSPHRASE: z.string().default(''),
  BYBIT_API_HOST: z
    .enum([
      'api.bybit.com',
      'api.bybit.tr',
      'api.bybit.kz',
      'api.bybit.ae',
      'api.bybitgeorgia.ge',
      'api.bybit.id',
    ])
    .default('api.bybit.com'),
  BYBIT_DEMO_API_KEY: z.string().default(''),
  BYBIT_DEMO_SECRET: z.string().default(''),
  BYBIT_LIVE_API_KEY: z.string().default(''),
  BYBIT_LIVE_SECRET: z.string().default(''),
  BINANCE_DEMO_API_KEY: z.string().default(''),
  BINANCE_DEMO_SECRET: z.string().default(''),
  BINANCE_LIVE_API_KEY: z.string().default(''),
  BINANCE_LIVE_SECRET: z.string().default(''),
  BITGET_DEMO_API_KEY: z.string().default(''),
  BITGET_DEMO_SECRET: z.string().default(''),
  BITGET_DEMO_PASSPHRASE: z.string().default(''),
  BITGET_LIVE_API_KEY: z.string().default(''),
  BITGET_LIVE_SECRET: z.string().default(''),
  BITGET_LIVE_PASSPHRASE: z.string().default(''),
})

export type Config = z.infer<typeof schema>
let cached: Config | undefined
export function config(): Config {
  if (cached) return cached
  const c = schema.parse(process.env)
  if ((c.MODEL_PROVIDER === 'demo') !== (c.SEARCH_PROVIDER === 'demo'))
    throw new Error('DEMO_PROVIDERS_MUST_MATCH')
  if (c.MODEL_PROVIDER === 'openai' && c.OPENAI_TRANSPORT === 'openai' && !c.OPENAI_API_KEY)
    throw new Error('OPENAI_CREDENTIALS_REQUIRED')
  if (c.MODEL_PROVIDER === 'openai' && c.OPENAI_TRANSPORT === 'openrouter' && !c.OPENROUTER_API_KEY)
    throw new Error('OPENROUTER_CREDENTIALS_REQUIRED')
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
    if (!c.SEPOLIA_RPC_URL.startsWith('https://') && !(c.SEPOLIA_LOCAL_NODE && isLocalRpc(c)))
      throw new Error('HTTPS_RPC_REQUIRED')
  }
  if (c.PUBLIC_TERMS_URL) {
    const terms = URL.canParse(c.PUBLIC_TERMS_URL) ? new URL(c.PUBLIC_TERMS_URL) : null
    if (terms?.protocol !== 'https:' || terms.username || terms.password)
      throw new Error('PUBLIC_TERMS_URL_INVALID')
  }
  // Search engines may index the public site only after the seller details and terms exist.
  if (c.PUBLIC_INDEXING && (!c.PUBLIC_SELLER || !c.PUBLIC_CONTACT || !c.PUBLIC_TERMS_URL))
    throw new Error('PUBLIC_INDEXING_REQUIRES_SELLER_TERMS')
  if (new URL(c.APP_ORIGIN).protocol === 'https:' && !c.SECURE_COOKIE)
    throw new Error('HTTPS_REQUIRES_SECURE_COOKIE')
  if (c.VM_AGENT_URL) {
    const u = URL.canParse(c.VM_AGENT_URL) ? new URL(c.VM_AGENT_URL) : null
    if (
      !u ||
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/'
    )
      throw new Error('VM_AGENT_URL_INVALID')
    if (c.VM_AGENT_TOKEN.length < 32) throw new Error('VM_AGENT_TOKEN_REQUIRED')
  }
  cached = c
  return c
}

/** Whether the worker may drive the VM browser with the real model or the demo script. */
export function computerUseReady(c: Config) {
  if (!c.COMPUTER_USE_ENABLED) return 'COMPUTER_USE_DISABLED_ON_SERVER'
  if (c.MODEL_PROVIDER === 'demo') return ''
  if (c.MODEL_PROVIDER !== 'openai' || c.OPENAI_TRANSPORT !== 'openrouter')
    return 'COMPUTER_USE_PROVIDER_UNSUPPORTED'
  if (!c.VM_AGENT_URL || !c.VM_AGENT_TOKEN) return 'COMPUTER_USE_VM_NOT_CONFIGURED'
  return ''
}

/** Loopback or a compose service name: only for SEPOLIA_LOCAL_NODE (anvil). */
export function isLocalRpc(c: Pick<Config, 'SEPOLIA_RPC_URL'>) {
  const u = URL.canParse(c.SEPOLIA_RPC_URL) ? new URL(c.SEPOLIA_RPC_URL) : null
  return (
    !!u &&
    u.protocol === 'http:' &&
    !u.username &&
    !u.password &&
    ['127.0.0.1', 'localhost', '[::1]', 'anvil', 'host.docker.internal'].includes(u.hostname)
  )
}

/** Free models distorted rewritten posts; their social service only lays out the full source text. */
export function usesSourcePosts(provider: string) {
  return provider === 'ollama' || provider === 'openrouter'
}
/** Recorded model of the paid provider; a transport change mid-job is then refused. */
export function paidModelId(c: Pick<Config, 'OPENAI_MODEL' | 'OPENAI_TRANSPORT'>) {
  return c.OPENAI_TRANSPORT === 'openrouter' ? `openai/${c.OPENAI_MODEL}` : c.OPENAI_MODEL
}
export function isFreeOpenrouterModel(model: string) {
  return (
    model === 'openrouter/free' ||
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*:free$/.test(model)
  )
}
