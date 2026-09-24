import { defineEventHandler, getRequestIP, setCookie } from 'h3'
import { z } from 'zod'
import { config } from '../../../core/config'
import { attemptLogin } from '../../../core/auth'
import { body, respond } from '../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(event, z.object({ password: z.string().max(200) }).strict())
    const token = await attemptLogin(input.password, getRequestIP(event) || 'unknown')
    setCookie(event, 'farm_session', token, {
      httpOnly: true,
      secure: config().SECURE_COOKIE,
      sameSite: 'strict',
      path: '/',
      maxAge: 43200,
    })
    return { ok: true }
  }),
)
