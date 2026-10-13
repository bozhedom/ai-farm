import { defineEventHandler } from 'h3'
import { earningsView } from '../../../core/earnings/monitor'
import { respond } from '../../utils/api'

export default defineEventHandler(() => respond(earningsView))
