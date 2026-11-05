import { defineEventHandler } from 'h3'
import { profileSchema, saveProfile } from '../../../../core/agent-profiles'
import { body, respond } from '../../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(event, profileSchema)
    if (input.role === 'manager') throw new Error('TRADING_INSTRUCTIONS_USE_APPLY')
    await saveProfile(input)
    return { ok: true }
  }),
)
