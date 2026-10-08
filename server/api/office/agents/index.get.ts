import { defineEventHandler } from 'h3'
import { officeAgents } from '../../../../core/office'
import { respond } from '../../../../server/utils/api'

export default defineEventHandler(() => respond(() => officeAgents()))
