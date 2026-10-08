import { defineEventHandler, getQuery } from 'h3'
import { officeLeads } from '../../../../core/office'
import { respond } from '../../../../server/utils/api'

export default defineEventHandler((event) => respond(() => officeLeads(getQuery(event))))
