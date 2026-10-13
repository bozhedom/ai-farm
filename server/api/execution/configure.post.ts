import { defineEventHandler } from 'h3'
import { allocationSchema } from '../../../core/execution/store'
import { configureExecution } from '../../../core/execution/engine'
import { body, respond } from '../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => configureExecution(await body(event, allocationSchema))),
)
