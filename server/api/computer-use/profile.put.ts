import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { saveProfile } from '../../../core/computer-use/profile'
import { body, respond } from '../../utils/api'
/**
 * The owner replaces the performer profile. Session and Origin are checked by the server
 * middleware; shape and content are validated by `saveProfile` with stable error codes.
 */
export default defineEventHandler((event) =>
  respond(async () => {
    const { profile } = await body(event, z.object({ profile: z.unknown() }).strict())
    return saveProfile(profile)
  }),
)
