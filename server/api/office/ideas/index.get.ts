import { defineEventHandler, getQuery } from 'h3'
import { officeIdeas } from '../../../../core/office'
import { respond } from '../../../../server/utils/api'

export default defineEventHandler((event) => respond(() => officeIdeas(getQuery(event))))
