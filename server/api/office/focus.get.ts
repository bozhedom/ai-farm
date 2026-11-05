import { defineEventHandler } from 'h3'
import { workFocus } from '../../../core/work-focus'
import { respond } from '../../utils/api'
export default defineEventHandler(() => respond(() => workFocus()))
