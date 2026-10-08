import { defineEventHandler } from 'h3'
import { officeSettings } from '../../../core/office'
import { respond } from '../../../server/utils/api'

export default defineEventHandler(() => respond(() => officeSettings()))
