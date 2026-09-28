import { config } from '../config'

/** Probe local services before claiming work, including after a Docker daemon restart. */
export async function localProviderReadiness() {
  const c = config()
  async function ready(base: string, path: string) {
    try {
      const response = await fetch(new URL(path, base), {
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      })
      await response.body?.cancel()
      return response.ok
    } catch {
      return false
    }
  }
  const [model, search] = await Promise.all([
    c.MODEL_PROVIDER === 'ollama' ? ready(c.OLLAMA_URL, '/api/version') : true,
    c.SEARCH_PROVIDER === 'searxng' ? ready(c.SEARXNG_URL, '/healthz') : true,
  ])
  return { model, search }
}
