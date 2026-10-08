import { defineEventHandler, getQuery } from 'h3'
import { officeReports } from '../../../core/office'
import { respond } from '../../../server/utils/api'

export default defineEventHandler((event) => respond(() => officeReports(getQuery(event))))
