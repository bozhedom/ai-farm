import type { IdeaStatus, OfficeMode, OfficeSettingsUpdate } from '../../../core/contracts/office'
import { errorMessage } from './errors'
import { officeFetch, refreshOffice } from './resource'

/**
 * Owner actions. Models never call these; the server checks every request. After a successful
 * action everything on screen is refetched at once.
 */

export type Toast = { id: number; text: string; tone: 'ok' | 'err' }

export function useOfficeToast() {
  const toast = useState<Toast | null>('office-toast', () => null)
  let timer: ReturnType<typeof setTimeout> | undefined
  function show(text: string, tone: Toast['tone'] = 'ok') {
    toast.value = { id: Date.now(), text, tone }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => (toast.value = null), tone === 'err' ? 7000 : 3500)
  }
  return { toast, show }
}

export function useOfficeAction() {
  const busy = ref<string | null>(null)
  const error = ref('')
  const { show } = useOfficeToast()
  async function run<T>(name: string, action: () => Promise<T>, success?: string) {
    if (busy.value) return undefined
    busy.value = name
    error.value = ''
    try {
      const result = await action()
      if (success) show(success)
      void refreshOffice()
      return result
    } catch (e) {
      error.value = errorMessage(e)
      show(error.value, 'err')
      return undefined
    } finally {
      busy.value = null
    }
  }
  return { busy, error, run }
}

const post = <T = unknown>(url: string, body: unknown = {}) =>
  officeFetch<T>(url, { method: 'POST', body: body as Record<string, unknown> })

export const officeApi = {
  setMode: (mode: OfficeMode) => post('/api/control', { action: mode }),
  setSchedule: (enabled: boolean) =>
    post('/api/control', { action: enabled ? 'schedule_on' : 'schedule_off' }),
  setResearchScope: (scope: 'rotate' | 'all') =>
    post('/api/control', { action: 'research_scope', scope }),
  findIdeas: () => post('/api/office/scout', {}),
  evolve: () => post('/api/office/agents/evolve', {}),
  setVisibility: (id: string, visibility: 'public' | 'private') =>
    post(`/api/office/products/${encodeURIComponent(id)}/visibility`, { visibility }),
  saveIdea: (id: string, patch: { ownerNote?: string; status?: IdeaStatus }) =>
    post(`/api/office/ideas/${encodeURIComponent(id)}`, patch),
  updateLead: (id: string, stage: string, note = '') =>
    post(`/api/opportunities/${encodeURIComponent(id)}`, { stage, note }),
  redraftLead: (id: string) => post(`/api/office/leads/${encodeURIComponent(id)}/draft`, {}),
  saveSettings: (update: OfficeSettingsUpdate) => post('/api/office/settings', update),
  resolveOrder: (id: string, reason: string) =>
    post(`/api/orders/${encodeURIComponent(id)}/resolve`, { reason }),
  payOrder: (id: string, body: { mode: 'sandbox' } | { mode: 'sepolia'; hash: string }) =>
    post(`/api/orders/${encodeURIComponent(id)}/pay`, body),
  createOrder: (productId: string, input: string, requestKey: string) =>
    post<{ id: string }>('/api/orders', { productId, input, requestKey }),
  login: (password: string) => post('/api/auth/login', { password }),
  logout: () => post('/api/auth/logout', {}),
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
