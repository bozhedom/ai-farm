import { defineEventHandler } from 'h3'
import { officeMoney } from '../../../core/office'
import { respond } from '../../../server/utils/api'

export default defineEventHandler(() => respond(() => officeMoney()))
