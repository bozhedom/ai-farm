import { defineEventHandler, getRouterParam } from 'h3'
import { deleteContext } from '../../../../../core/agent-profiles'
import { respond } from '../../../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    await deleteContext(String(getRouterParam(event, 'id') ?? ''))
    return { ok: true }
  }),
)
