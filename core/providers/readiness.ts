import { config } from '../config'

/** Probe local services before claiming work, including after a Docker daemon restart. */
export async function localProviderReadiness() {
  const c = config()
  const modelName = (name: string) =>
    name.lastIndexOf(':') > name.lastIndexOf('/') ? name : `${name}:latest`
  async function ready(base: string, path: string, expectedModel?: string) {
    let response: Response | undefined
    try {
      response = await fetch(new URL(path, base), {
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      })
      if (!response.ok) return false
      if (!expectedModel) return true
      const raw = await response.text()
      if (raw.length > 2000000) return false
      const data = JSON.parse(raw)
      return (
        Array.isArray(data?.models) &&
        data.models.some(
          (item: { name?: unknown; model?: unknown } | null) =>
            item &&
            [item.name, item.model].some(
              (name) => typeof name === 'string' && modelName(name) === modelName(expectedModel),
            ),
        )
      )
    } catch {
      return false
    } finally {
      await response?.body?.cancel().catch(() => {})
    }
  }
  const [model, search] = await Promise.all([
    c.MODEL_PROVIDER === 'ollama' ? ready(c.OLLAMA_URL, '/api/tags', c.OLLAMA_MODEL) : true,
    c.SEARCH_PROVIDER === 'searxng' ? ready(c.SEARXNG_URL, '/healthz') : true,
  ])
  return { model, search }
}
