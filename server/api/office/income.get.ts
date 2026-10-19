import { defineEventHandler } from 'h3'
import { officeIncome } from '../../../core/income/view'
import { respond } from '../../../server/utils/api'

export default defineEventHandler(() => respond(() => officeIncome()))
