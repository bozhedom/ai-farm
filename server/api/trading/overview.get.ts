import { defineEventHandler, getQuery } from 'h3'
import { z } from 'zod'
import { tradingOverview } from '../../../core/trading/overview'
import { respond } from '../../utils/api'

export default defineEventHandler((event) =>
  respond(async () => {
    const { mode } = z
      .object({ mode: z.enum(['paper', 'demo', 'live']).default('paper') })
      .strict()
      .parse(getQuery(event))
    return tradingOverview(mode)
  }),
)
