import type {
  IdeaStatus,
  OfficeAgents,
  OfficeIdea,
  OfficeIdeaList,
  OfficeJournal,
  OfficeLead,
  OfficeMoney,
  OfficeOrderSummary,
  OfficeOverview,
  OfficeProduct,
  OfficeReport,
  OfficeSettings,
} from '../../../core/contracts/office'
import type { OfficeIncome } from '../../../core/contracts/overview'
import { officeFetch, useOfficeResource } from './resource'

/**
 * Loading for every office section, strictly by `core/contracts/office.ts`. List endpoints may
 * answer with a bare array or with `{ items }`; both are accepted.
 */

export type Page<T> = { items: T[]; total: number; offset: number; limit: number; hasMore: boolean }

export function asList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  const items = (raw as { items?: unknown } | null)?.items
  return Array.isArray(items) ? (items as T[]) : []
}

function asPage<T>(raw: unknown): Page<T> {
  const items = asList<T>(raw)
  const page = (raw || {}) as Partial<Page<T>>
  // Extra fields of a list answer (idea counts, industries) stay with the page.
  return {
    ...(Array.isArray(raw) ? {} : page),
    items,
    total: typeof page.total === 'number' ? page.total : items.length,
    offset: typeof page.offset === 'number' ? page.offset : 0,
    limit: typeof page.limit === 'number' && page.limit > 0 ? page.limit : items.length || 50,
    hasMore: !!page.hasMore,
  }
}

const query = (values: Record<string, string | number | null | undefined>) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values))
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value))
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** Loads `pages` consecutive pages and merges them, so «Показать ещё» survives polling. */
async function pagedFetch<T>(url: string, filters: Record<string, string>, pages: number) {
  const first = asPage<T>(await officeFetch(url + query({ ...filters, offset: 0 })))
  if (pages <= 1 || !first.hasMore) return first
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) =>
      officeFetch(url + query({ ...filters, offset: (i + 1) * first.limit })).then((raw) =>
        asPage<T>(raw),
      ),
    ),
  )
  const last = { ...first, ...(rest.at(-1) || {}) }
  const seen = new Set<string>()
  const items = [first, ...rest]
    .flatMap((page) => page.items)
    .filter((item) => {
      const id = (item as { id?: string }).id || JSON.stringify(item)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  return { ...last, items, offset: 0 }
}

export function useOfficeOverview() {
  return useOfficeResource('overview', () => officeFetch<OfficeOverview>('/api/office/overview'))
}

/** How the farm earns: `/api/office/income`, one aggregated snapshot for the main screen. */
export function useOfficeIncome(interval = 10000) {
  return useOfficeResource('income', () => officeFetch<OfficeIncome>('/api/office/income'), {
    interval,
  })
}

export function useOfficeAgents(interval = 5000) {
  return useOfficeResource('agents', () => officeFetch<OfficeAgents>('/api/office/agents'), {
    interval,
  })
}

export function useOfficeMoney(interval = 5000) {
  return useOfficeResource('money', () => officeFetch<OfficeMoney>('/api/office/money'), {
    interval,
  })
}

export function useOfficeSettings(interval = 15000) {
  return useOfficeResource('settings', () => officeFetch<OfficeSettings>('/api/office/settings'), {
    interval,
  })
}

export function useOfficeProducts() {
  return useOfficeResource('products', () =>
    officeFetch<unknown>('/api/office/products').then((raw) => asList<OfficeProduct>(raw)),
  )
}

export function useOfficeReports() {
  return useOfficeResource(
    'reports',
    () => officeFetch<unknown>('/api/office/reports').then((raw) => asList<OfficeReport>(raw)),
    { interval: 30000 },
  )
}

export type IdeaView = '' | 'farm' | 'human' | 'rejected' | 'taken' | 'done'
export type IdeaFilters = { status: IdeaStatus | ''; category: string; view?: IdeaView }

export function useOfficeIdeas(filters: Ref<IdeaFilters>) {
  const pages = ref(1)
  watch(
    () => [filters.value.status, filters.value.category, filters.value.view],
    () => (pages.value = 1),
  )
  const key = computed(
    () =>
      `ideas:${filters.value.status}:${filters.value.category}:${filters.value.view || ''}:${pages.value}`,
  )
  const resource = useOfficeResource(key, () =>
    pagedFetch<OfficeIdea>(
      '/api/office/ideas',
      {
        status: filters.value.status,
        category: filters.value.category,
        view: filters.value.view || '',
      },
      pages.value,
    ).then((page) => page as OfficeIdeaList),
  )
  // Keep the previous list on screen while the next page or filter loads.
  const shown = ref<OfficeIdeaList | undefined>()
  watch(
    resource.data,
    (value) => {
      if (value) shown.value = value
    },
    { immediate: true },
  )
  return { ...resource, data: shown, more: () => (pages.value += 1) }
}

export function useOfficeIdea(id: MaybeRefOrGetter<string>) {
  return useOfficeResource(
    () => `idea:${toValue(id)}`,
    () => officeFetch<OfficeIdea>(`/api/office/ideas/${encodeURIComponent(toValue(id))}`),
  )
}

export function useOfficeOrders() {
  const pages = ref(1)
  const resource = useOfficeResource(
    () => `orders:${pages.value}`,
    () => pagedFetch<OfficeOrderSummary>('/api/office/orders', {}, pages.value),
  )
  const shown = ref<Page<OfficeOrderSummary> | undefined>()
  watch(
    resource.data,
    (value) => {
      if (value) shown.value = value
    },
    { immediate: true },
  )
  return { ...resource, data: shown, more: () => (pages.value += 1) }
}

/** Leads come from `/api/office/leads` (slice B); snake_case rows are still normalised. */
function toLead(raw: Record<string, unknown>): OfficeLead {
  const pick = <T>(camel: string, snake: string, fallback: T): T =>
    (raw[camel] ?? raw[snake] ?? fallback) as T
  return {
    id: String(raw.id),
    product: (raw.product as OfficeLead['product']) ?? null,
    template: String(raw.template ?? ''),
    url: String(raw.url ?? ''),
    title: String(raw.title ?? ''),
    snippet: String(raw.snippet ?? ''),
    stage: String(raw.stage ?? 'new'),
    note: String(raw.note ?? ''),
    replyDraft: pick<string | null>('replyDraft', 'reply_draft', null),
    replyDraftedAt: pick<string | null>('replyDraftedAt', 'reply_drafted_at', null),
    replyError: pick<string | null>('replyError', 'reply_error', null),
    isDemo: !!pick('isDemo', 'is_demo', false),
    firstSeenAt: pick('firstSeenAt', 'first_seen_at', ''),
    lastSeenAt: pick('lastSeenAt', 'last_seen_at', ''),
  }
}

export function useOfficeLeads() {
  const pages = ref(1)
  const resource = useOfficeResource(
    () => `leads:${pages.value}`,
    () =>
      pagedFetch<Record<string, unknown>>('/api/office/leads', {}, pages.value).then((page) => ({
        ...page,
        items: page.items.map(toLead),
      })),
  )
  return { ...resource, more: () => (pages.value += 1) }
}

/** Owner view of one order from the existing `/api/orders/[id]`. */
export type OwnerOrder = {
  id: string
  /** Short order number, «Заказ №1042». */
  number?: number
  /** Service name, the same as on the site. */
  productName?: string
  agent?: { id: string; name: string; label: string } | null
  status: string
  source?: 'owner' | 'public'
  payment_mode: string
  is_test_payment?: boolean
  price_kopecks?: number
  product_id: string
  product_snapshot: { name: string; version: number }
  strategy_snapshot?: { name?: string } | null
  input: string
  result: string | null
  review?: { reason?: string } | null
  resolution_reason?: string | null
  closed_at?: string | null
  created_at: string
  paid_at?: string | null
  delivered_at?: string | null
  expires_at?: string | null
  receiver?: string | null
  amount_wei?: string | null
  tx_hash?: string | null
  required_confirmations?: number
  payment_proof?: {
    hash: string
    blockNumber: number | string
    blockTime: string
    confirmations: number
  } | null
  progress: {
    title: string
    detail: string
    tone: 'good' | 'warn'
    canSubmit: boolean
    canResolve: boolean
    errorCode: string | null
  }
  job: {
    status: string
    attempts: number
    max_attempts: number
    run_after: string | null
    error_code: string | null
  } | null
  steps: { label: string; at: string | null; done: boolean }[]
  paymentAttempts: {
    tx_hash: string
    submitted_at: string
    checked_at: string | null
    confirmations: number
    confirmed_at: string | null
    active: boolean
    errorText: string | null
  }[]
}

export function useOwnerOrder(id: MaybeRefOrGetter<string>) {
  return useOfficeResource(
    () => `order:${toValue(id)}`,
    () => officeFetch<OwnerOrder>(`/api/orders/${encodeURIComponent(toValue(id))}`),
    { interval: 3000 },
  )
}

export type ProductVersion = {
  version: number
  spec: { name: string; audience?: string; promise?: string }
  checks?: { reason?: string; input?: string; sample?: string } | null
  critique?: { verdict: string; reason: string } | null
  is_demo: boolean
  created_at: string
  model: string | null
}

export const productVersions = (id: string, before?: number | null) =>
  officeFetch<{ versions: ProductVersion[]; nextBefore: number | null }>(
    `/api/products/${encodeURIComponent(id)}/versions${query({ before })}`,
  )

/** Server health from the existing readiness check. A degraded answer still carries the body. */
export type Readiness = {
  status: 'ok' | 'degraded'
  checks: Record<string, boolean>
  providers?: { checkedAt: string | null; fresh: boolean }
  checkedAt: string
}

export function useReadiness() {
  return useOfficeResource(
    'readiness',
    () => officeFetch<Readiness>('/api/readiness', { ignoreResponseError: true }),
    { interval: 15000 },
  )
}

/** Technical journal from `/api/office/journal`: events and jobs in plain words. */
export type Journal = {
  audit: { id: number | string; message: string; created_at: string }[]
  jobs: {
    id: string
    kind: string
    status: string
    attempts: number
    error_code: string | null
    created_at: string
  }[]
}

export function useJournal(enabled: Ref<boolean>) {
  return useOfficeResource(
    () => (enabled.value ? 'journal' : null),
    () =>
      officeFetch<Partial<OfficeJournal>>('/api/office/journal').then((raw) => ({
        audit: (raw.events ?? [])
          .slice(0, 50)
          .map((event) => ({ id: event.id, message: event.text, created_at: event.at })),
        jobs: (raw.jobs ?? []).slice(0, 20).map((job) => ({
          id: job.id,
          kind: job.kind,
          status: job.status,
          attempts: job.attempts,
          error_code: job.error,
          created_at: job.createdAt,
        })),
      })),
    { interval: 10000 },
  )
}
