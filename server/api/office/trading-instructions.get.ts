import { defineEventHandler } from 'h3'
import { tradingInstructions } from '../../../core/trading/owner-rules'
import { respond } from '../../utils/api'
export default defineEventHandler(() => respond(() => tradingInstructions()))
