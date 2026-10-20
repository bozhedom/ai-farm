import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { setPlatformLogin } from '../../../core/computer-use/runtime'
import { computerUseView } from '../../../core/computer-use/view'
import { body, respond } from '../../utils/api'
/** The owner marks a platform as logged in (or not) for the browser profile on the VM. */
export default defineEventHandler((event) =>
  respond(async () => {
    const { domain, loggedIn } = await body(
      event,
      z.object({ domain: z.string().trim().min(3).max(100), loggedIn: z.boolean() }).strict(),
    )
    await setPlatformLogin(domain, loggedIn)
    return computerUseView()
  }),
)
