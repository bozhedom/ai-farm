import { defineEventHandler } from 'h3'
import { managerView } from '../../../../core/manager/view'
import { respond } from '../../../utils/api'
export default defineEventHandler(() => respond(managerView))
