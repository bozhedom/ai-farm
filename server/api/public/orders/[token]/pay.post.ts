import { defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import type { PublicPayResponse } from '../../../../../core/contracts/public'
import { payPublicOrder } from '../../../../../core/public-orders'
import { body, respond } from '../../../../utils/api'
import { limitPublic } from '../../../../utils/client'

export default defineEventHandler((event) =>
  respond(async (): Promise<PublicPayResponse> => {
    await limitPublic(event, 'pay')
    const input = await body(
      event,
      z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('sandbox') }).strict(),
        z
          .object({ mode: z.literal('sepolia'), hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
          .strict(),
      ]),
    )
    return payPublicOrder(String(getRouterParam(event, 'token') || ''), input)
  }),
)
