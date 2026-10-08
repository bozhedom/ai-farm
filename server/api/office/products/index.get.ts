import { defineEventHandler, getQuery } from 'h3'
import { officeProducts } from '../../../../core/office'
import { respond } from '../../../../server/utils/api'

export default defineEventHandler((event) => respond(() => officeProducts(getQuery(event))))
