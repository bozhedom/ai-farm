import { defineEventHandler } from 'h3'
import { z } from 'zod'
import {
  deleteCredentials,
  loginGoal,
  saveCredentials,
  storedLoginUrl,
} from '../../../core/computer-use/credentials'
import { addOwnerGoal } from '../../../core/computer-use/runtime'
import { computerUseView } from '../../../core/computer-use/view'
import { body, respond } from '../../utils/api'
/**
 * The owner stores or removes a platform login for the model. The values are encrypted before
 * they reach the database and are never returned; `signIn` and `sign_in` queue a task that
 * logs in now.
 */
export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(
      event,
      z.discriminatedUnion('action', [
        z
          .object({
            action: z.literal('save'),
            domain: z.string().max(100),
            username: z.string().max(200),
            password: z.string().max(200),
            loginUrl: z.string().max(2000).default(''),
            signIn: z.boolean().default(false),
          })
          .strict(),
        z.object({ action: z.literal('delete'), domain: z.string().max(100) }).strict(),
        z.object({ action: z.literal('sign_in'), domain: z.string().max(100) }).strict(),
      ]),
    )
    if (input.action === 'delete') {
      await deleteCredentials(input.domain)
      return computerUseView()
    }
    if (input.action === 'sign_in') {
      const domain = input.domain.trim().toLowerCase()
      await addOwnerGoal(loginGoal(domain, await storedLoginUrl(domain)))
      return computerUseView()
    }
    const { action: _, signIn, ...login } = input
    const domain = await saveCredentials(login)
    if (signIn) await addOwnerGoal(loginGoal(domain, login.loginUrl.trim()))
    return computerUseView()
  }),
)
