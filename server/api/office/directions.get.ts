import { defineEventHandler } from 'h3'
import { directionReadiness } from '../../../core/earnings/readiness'
import { respond } from '../../utils/api'
export default defineEventHandler(() => respond(directionReadiness))
