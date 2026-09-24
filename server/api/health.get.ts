import { defineEventHandler, setResponseStatus } from 'h3'
import { query } from '../../core/db'
export default defineEventHandler(async (event) => {
  try {
    await query('SELECT 1')
    return { status: 'ok' }
  } catch {
    setResponseStatus(event, 503)
    return { status: 'unavailable' }
  }
})
