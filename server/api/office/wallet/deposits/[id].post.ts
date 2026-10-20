import { defineEventHandler, getRouterParam } from 'h3'
import { classificationSchema, classifyDeposit } from '../../../../../core/wallet/sync'
import { body, respond } from '../../../../../server/utils/api'

/** Owner only (session middleware): mark a deposit as income, not income or unclassified. */
export default defineEventHandler((event) =>
  respond(async () => {
    const { classification } = await body(event, classificationSchema)
    return classifyDeposit(String(getRouterParam(event, 'id') ?? ''), classification)
  }),
)
