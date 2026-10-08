import { describeError } from './errors'

/**
 * Shared polling for the owner office. Every resource has a string key; pages that show the same
 * data share one timer and one cached value. Polling pauses while the tab is hidden and catches
 * up immediately when it becomes visible again. Data is fetched in the browser only.
 */

export type ResourceStatus = {
  loading: boolean
  /** Network failure or server error: the page keeps showing the last good data. */
  offline: boolean
  /** The resource does not exist (404). */
  missing: boolean
  error: string
  at: number
}

type Entry = {
  subscribers: number
  timer: ReturnType<typeof setInterval> | null
  inflight: Promise<void> | null
  fetcher: () => Promise<unknown>
  interval: number
}

const registry = new Map<string, Entry>()
let visibilityBound = false
/** Captured in setup so timers can update state and navigate outside a component context. */
let stores: {
  cache: Ref<Record<string, unknown>>
  statuses: Ref<Record<string, ResourceStatus>>
  online: Ref<boolean>
  app: ReturnType<typeof useNuxtApp>
} | null = null

const idleStatus = (): ResourceStatus => ({
  loading: false,
  offline: false,
  missing: false,
  error: '',
  at: 0,
})

export const officeFetch = <T>(url: string, options: Parameters<typeof $fetch>[1] = {}) =>
  $fetch<T>(url, { timeout: 12000, ...options } as Parameters<typeof $fetch>[1]) as Promise<T>

function useCache() {
  return useState<Record<string, unknown>>('office-cache', () => ({}))
}
function useStatuses() {
  return useState<Record<string, ResourceStatus>>('office-status', () => ({}))
}
/** False after any failed request, true again after any successful one. */
export function useOfficeOnline() {
  return useState('office-online', () => true)
}

function bindStores() {
  stores ||= {
    cache: useCache(),
    statuses: useStatuses(),
    online: useOfficeOnline(),
    app: useNuxtApp(),
  }
  return stores
}

async function run(key: string) {
  const entry = registry.get(key)
  if (!entry || !stores) return
  if (entry.inflight) return entry.inflight
  const { cache, statuses, online, app } = stores
  const previous = statuses.value[key] || idleStatus()
  statuses.value = { ...statuses.value, [key]: { ...previous, loading: true } }
  entry.inflight = (async () => {
    try {
      const value = await entry.fetcher()
      cache.value = { ...cache.value, [key]: value }
      statuses.value = {
        ...statuses.value,
        [key]: { loading: false, offline: false, missing: false, error: '', at: Date.now() },
      }
      online.value = true
    } catch (error) {
      const info = describeError(error)
      if (info.status === 401) {
        await app.runWithContext(() => navigateTo('/office/login'))
        return
      }
      const offline = info.status === 0 || info.status >= 500
      if (offline) online.value = false
      statuses.value = {
        ...statuses.value,
        [key]: {
          ...(statuses.value[key] || idleStatus()),
          loading: false,
          offline,
          missing: info.status === 404,
          error: info.text,
        },
      }
    } finally {
      entry.inflight = null
    }
  })()
  return entry.inflight
}

function bindVisibility() {
  if (visibilityBound || typeof document === 'undefined') return
  visibilityBound = true
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) for (const key of registry.keys()) void run(key)
  })
}

function subscribe(key: string, fetcher: () => Promise<unknown>, interval: number) {
  bindVisibility()
  let entry = registry.get(key)
  if (!entry) {
    entry = { subscribers: 0, timer: null, inflight: null, fetcher, interval }
    registry.set(key, entry)
  }
  entry.fetcher = fetcher
  entry.subscribers += 1
  if (!entry.timer && interval > 0) {
    entry.interval = interval
    entry.timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      void run(key)
    }, interval)
  }
  void run(key)
}

function unsubscribe(key: string) {
  const entry = registry.get(key)
  if (!entry) return
  entry.subscribers -= 1
  if (entry.subscribers > 0) return
  if (entry.timer) clearInterval(entry.timer)
  registry.delete(key)
}

/** Refetches every resource that is on screen now, for example after an owner action. */
export async function refreshOffice() {
  await Promise.all([...registry.keys()].map((key) => run(key)))
}

export function useOfficeResource<T>(
  key: MaybeRefOrGetter<string | null>,
  fetcher: () => Promise<T>,
  options: { interval?: number } = {},
) {
  const interval = options.interval ?? 5000
  const cache = useCache()
  const statuses = useStatuses()
  if (import.meta.client) bindStores()
  const currentKey = computed(() => toValue(key))
  const data = computed(() =>
    currentKey.value ? (cache.value[currentKey.value] as T | undefined) : undefined,
  )
  const status = computed(
    () => (currentKey.value && statuses.value[currentKey.value]) || idleStatus(),
  )
  let active: string | null = null
  if (import.meta.client) {
    onMounted(() => {
      watch(
        currentKey,
        (next) => {
          if (active) unsubscribe(active)
          active = next
          if (next) subscribe(next, fetcher, interval)
        },
        { immediate: true },
      )
    })
    onBeforeUnmount(() => {
      if (active) unsubscribe(active)
      active = null
    })
  }
  return {
    data,
    status,
    /** True until the first answer (good or bad) for the current key. */
    pending: computed(() => !data.value && !status.value.at && !status.value.error),
    refresh: () => (currentKey.value ? run(currentKey.value) : Promise.resolve()),
  }
}
