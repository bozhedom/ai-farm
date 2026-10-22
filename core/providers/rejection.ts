/**
 * The provider refused the request itself before any generation: a malformed body or schema,
 * a bad key, a missing model. Such answers are not billed. Timeouts, rate limits (408, 429),
 * server errors and network failures stay ambiguous and keep the pessimistic charge.
 */
export const notStartedStatuses: readonly number[] = [400, 401, 403, 404, 422]

/** A provider HTTP failure with the provider's own short explanation, for the ledger. */
export class ProviderHttpError extends Error {
  readonly status: number
  readonly detail: string | null
  constructor(code: string, status: number, detail: string | null) {
    super(code)
    this.name = 'ProviderHttpError'
    this.status = status
    this.detail = detail
  }
}

/** Rejected before generation: nothing was billed (see `notStartedStatuses`). */
export class ProviderRejectedError extends ProviderHttpError {
  constructor(code: string, status: number, detail: string | null) {
    super(code, status, detail)
    this.name = 'ProviderRejectedError'
  }
}

export const errorDetailLimit = 300

/** Removes anything key-like and bounds the length. The text comes from the provider. */
export function sanitizeErrorDetail(text: string) {
  const clean = text
    .replace(/Bearer\s+\S+/giu, 'Bearer [скрыто]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/gu, '[ключ скрыт]')
    .replace(/[A-Za-z0-9_-]{40,}/gu, '[скрыто]')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return clean ? clean.slice(0, errorDetailLimit) : null
}

/**
 * The provider's `error.code`, `error.message` and, when present, the upstream explanation
 * `error.metadata.raw` (OpenRouter puts a schema complaint there). Never the request.
 */
export function providerErrorDetail(body: string) {
  let data: any
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  const error = data?.error
  if (!error || typeof error !== 'object') return null
  const parts = [
    error.code !== undefined && error.code !== null ? `code ${String(error.code)}` : '',
    typeof error.message === 'string' ? error.message : '',
    typeof error.metadata?.raw === 'string' ? error.metadata.raw : '',
  ].filter(Boolean)
  return parts.length ? sanitizeErrorDetail(parts.join(': ')) : null
}

/** The error for a non-OK HTTP answer: a rejection for `notStartedStatuses`. */
export function providerHttpError(prefix: string, status: number, body = '') {
  const code = `${prefix}_HTTP_${status}`
  const detail = providerErrorDetail(body)
  return notStartedStatuses.includes(status)
    ? new ProviderRejectedError(code, status, detail)
    : new ProviderHttpError(code, status, detail)
}

/** Reads at most `limit` bytes of an error answer; the rest is discarded. */
export async function readErrorBody(response: Response, limit = 8192) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < limit) {
      const part = await reader.read()
      if (part.done) break
      chunks.push(part.value)
      size += part.value.byteLength
    }
    await reader.cancel().catch(() => {})
  } catch {
    return ''
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8')
}
