import { defineEventHandler, getQuery } from 'h3'
import { officeOrders } from '../../../../core/office'
import { respond } from '../../../../server/utils/api'

export default defineEventHandler((event) => respond(() => officeOrders(getQuery(event))))
