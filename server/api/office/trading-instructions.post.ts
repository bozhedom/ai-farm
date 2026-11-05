import { defineEventHandler } from 'h3'
import {
  applyInstructionsSchema,
  applyTradingInstructions,
} from '../../../core/trading/instructions'
import { body, respond } from '../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => applyTradingInstructions(await body(event, applyInstructionsSchema))),
)
