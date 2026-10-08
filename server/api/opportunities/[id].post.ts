import { defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import { opportunityUpdateSchema, updateOpportunity } from '../../../core/opportunities'
import { body, respond } from '../../utils/api'

export default defineEventHandler((event) =>
  respond(async () => {
    const id = z.uuid().parse(getRouterParam(event, 'id'))
    const input = await body(event, opportunityUpdateSchema)
    return updateOpportunity(id, input)
  }),
)
