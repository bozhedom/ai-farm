import { defineEventHandler } from 'h3'
import { publicCatalog } from '../../../core/public-catalog'
import { respond } from '../../utils/api'

/** Open without the owner session; see server/middleware/security.ts. */
export default defineEventHandler(() => respond(publicCatalog))
