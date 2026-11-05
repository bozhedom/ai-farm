import { defineEventHandler } from 'h3'
import { workFocusSchema } from '../../../core/contracts/work-focus'
import { saveWorkFocus } from '../../../core/work-focus'
import { body, respond } from '../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => saveWorkFocus(await body(event, workFocusSchema))),
)
