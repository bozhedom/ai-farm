import { defineEventHandler } from 'h3'
import { assistantQuestionSchema } from '../../../core/contracts/assistant'
import { askAssistant } from '../../../core/assistant/service'
import { body, respond } from '../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => askAssistant(await body(event, assistantQuestionSchema))),
)
