import { defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import { sandboxPayment, submitTransaction } from '../../../../core/payments'
import { body, respond } from '../../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const id = z.uuid().parse(getRouterParam(event, 'id'))
    const input = await body(
      event,
      z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('sandbox') }).strict(),
        z
          .object({ mode: z.literal('sepolia'), hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
          .strict(),
      ]),
    )
    if (input.mode === 'sandbox') await sandboxPayment(id)
    else await submitTransaction(id, input.hash)
    return { ok: true }
  }),
)
