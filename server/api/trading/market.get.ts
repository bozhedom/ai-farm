import { defineEventHandler, getQuery } from 'h3'
import { z } from 'zod'
import { exchanges } from '../../../core/trading/types'
import { tradingMarketView } from '../../../core/trading/market-view'
import { respond } from '../../utils/api'

export default defineEventHandler((event) =>
  respond(async () => {
    const input = z
      .object({
        exchange: z.enum(exchanges),
        mode: z.enum(['paper', 'demo', 'live']),
        search: z.string().trim().max(40).default(''),
        filter: z.enum(['all', 'ready']).default('ready'),
        page: z.coerce.number().int().min(1).max(500).default(1),
      })
      .strict()
      .parse(getQuery(event))
    return tradingMarketView(input, input.search, input.filter, input.page)
  }),
)
