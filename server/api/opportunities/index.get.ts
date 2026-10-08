import { defineEventHandler, getQuery } from 'h3'
import { opportunityList, opportunityListSchema } from '../../../core/opportunities'
import { respond } from '../../utils/api'

export default defineEventHandler((event) =>
  respond(async () => opportunityList(opportunityListSchema.parse(getQuery(event)))),
)
