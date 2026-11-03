import { defineEventHandler } from 'h3'
import { contextSchema, addContext } from '../../../../core/agent-profiles'
import { body, respond } from '../../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => addContext(await body(event, contextSchema))),
)
