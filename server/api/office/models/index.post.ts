import { defineEventHandler } from 'h3'
import { profileSchema, saveProfile } from '../../../../core/agent-profiles'
import { body, respond } from '../../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    await saveProfile(await body(event, profileSchema))
    return { ok: true }
  }),
)
