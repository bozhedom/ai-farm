import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { requestLeadSearch } from '../../../../core/office'
import { body, respond } from '../../../../server/utils/api'

/** "Поискать ещё": lead searches for public products, within leads_per_day. */
export default defineEventHandler((event) =>
  respond(async () => {
    await body(event, z.object({}).strict().optional())
    return requestLeadSearch()
  }),
)
