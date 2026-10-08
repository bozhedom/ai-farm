import { describe, expect, it } from 'vitest'
import { respond } from '../../server/utils/api'

async function status(code: string) {
  try {
    await respond(async () => {
      throw new Error(code)
    })
  } catch (error) {
    return (error as { statusCode: number }).statusCode
  }
  throw new Error('NO_ERROR')
}

describe('API error codes', () => {
  it('maps rate limits to 429 and keeps the other statuses', async () => {
    expect(await status('RATE_LIMITED')).toBe(429)
    expect(await status('LOGIN_RATE_LIMIT')).toBe(429)
    expect(await status('LOGIN_FAILED')).toBe(401)
    expect(await status('ORDER_NOT_FOUND')).toBe(404)
    expect(await status('PUBLIC_ORDERS_LIMIT')).toBe(409)
    expect(await status('not a code')).toBe(500)
  })
})
