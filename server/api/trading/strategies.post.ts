import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { exchanges } from '../../../core/trading/types'
import { configurePaperStrategies, scope } from '../../../core/trading/store'
import { tradingView } from '../../../core/trading/view'
import { body, respond } from '../../utils/api'

export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(
      event,
      z.object({ exchange: z.enum(exchanges), preset: z.enum(['adaptive', 'classic']) }).strict(),
    )
    await configurePaperStrategies(input.exchange, input.preset)
    return tradingView(scope(input.exchange, 'paper'))
  }),
)
