import { createError, readBody, type H3Event } from 'h3'
import { z } from 'zod'

export async function body<T>(event: H3Event, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await readBody(event))
}
export async function respond<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof z.ZodError)
      throw createError({
        statusCode: 400,
        statusMessage: 'INVALID_INPUT',
        message: 'Проверьте формат и длину введённых данных.',
      })
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
        ? error.message
        : 'INTERNAL_ERROR'
    if (typeof error === 'object' && error && 'code' in error && error.code === '23505')
      throw createError({
        statusCode: 409,
        statusMessage: 'DUPLICATE_PAYMENT_OR_REQUEST',
        message: 'Транзакция или запрос уже использованы.',
      })
    const status =
      code === 'LOGIN_FAILED'
        ? 401
        : code === 'LOGIN_RATE_LIMIT'
          ? 429
          : code.endsWith('NOT_FOUND')
            ? 404
            : code === 'INTERNAL_ERROR'
              ? 500
              : 409
    throw createError({ statusCode: status, statusMessage: code, message: code })
  }
}
