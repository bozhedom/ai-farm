import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { exchanges } from '../../../core/trading/types'
import {
  checkTrading,
  controlTrading,
  resolveMissingOrder,
  startTrading,
  stopAllTrading,
} from '../../../core/trading/engine'
import { body, respond } from '../../utils/api'

const schema = z
  .object({
    exchange: z.enum(exchanges),
    mode: z.enum(['paper', 'demo', 'live']),
    action: z.enum([
      'check',
      'start',
      'pause',
      'stop',
      'stop_all',
      'flatten',
      'demo_probe',
      'resolve',
    ]),
    confirmation: z.string().max(80).default(''),
    clientId: z
      .string()
      .regex(/^[a-zA-Z0-9]{1,32}$/)
      .optional(),
  })
  .strict()

export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(event, schema)
    if (input.action === 'stop_all') await stopAllTrading()
    else if (input.action === 'check') await checkTrading(input)
    else if (input.action === 'start') await startTrading(input, input.confirmation)
    else if (input.action === 'demo_probe') {
      if (input.mode !== 'demo') throw new Error('TRADING_DEMO_ONLY')
      await startTrading(input, '', true)
    } else if (input.action === 'resolve') {
      if (!input.clientId) throw new Error('TRADING_REVIEW_NOT_READY')
      await resolveMissingOrder(input, input.clientId, input.confirmation)
    } else await controlTrading(input, input.action)
    return { ok: true }
  }),
)
