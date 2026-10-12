import { defineEventHandler, getQuery } from 'h3'
import { z } from 'zod'
import { tradingView } from '../../../core/trading/view'
import { respond } from '../../utils/api'

export default defineEventHandler((event) =>
  respond(async () => {
    const { mode } = z
      .object({ mode: z.enum(['paper', 'demo', 'live']).default('paper') })
      .parse(getQuery(event))
    return tradingView(mode)
  }),
)
