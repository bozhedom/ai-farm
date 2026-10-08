import { defineEventHandler } from 'h3'
import { officeOverview } from '../../../core/office'
import { respond } from '../../../server/utils/api'

export default defineEventHandler(() => respond(() => officeOverview()))
