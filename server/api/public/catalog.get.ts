import { defineEventHandler } from 'h3'
import { publicCatalog } from '../../../core/public-catalog'
import { respond } from '../../utils/api'
import { limitPublic } from '../../utils/client'

/** Open without the owner session; see server/middleware/security.ts. */
export default defineEventHandler((event) =>
  respond(async () => {
    await limitPublic(event, 'catalog')
    return publicCatalog()
  }),
)
