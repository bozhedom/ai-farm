import { defineEventHandler } from 'h3'
import { servicesCatalog } from '../../../core/services/store'
import { respond } from '../../utils/api'

export default defineEventHandler(() => respond(() => servicesCatalog()))
