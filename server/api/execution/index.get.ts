import { defineEventHandler, getQuery } from 'h3'
import { executionScopeSchema } from '../../../core/execution/store'
import { executionView } from '../../../core/execution/view'
import { respond } from '../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const { track, mode } = executionScopeSchema.parse(getQuery(event))
    return executionView(track, mode)
  }),
)
