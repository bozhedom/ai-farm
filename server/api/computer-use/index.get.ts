import { defineEventHandler } from 'h3'
import { computerUseView } from '../../../core/computer-use/view'
import { respond } from '../../utils/api'
export default defineEventHandler(() => respond(computerUseView))
