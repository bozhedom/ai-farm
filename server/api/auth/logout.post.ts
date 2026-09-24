import { defineEventHandler, deleteCookie, getCookie } from 'h3'
import { digest } from '../../../core/auth'
import { query } from '../../../core/db'
export default defineEventHandler(async (event) => {
  const token = getCookie(event, 'farm_session')
  if (token) await query('DELETE FROM sessions WHERE token_hash=$1', [digest(token)])
  deleteCookie(event, 'farm_session', { path: '/' })
  return { ok: true }
})
