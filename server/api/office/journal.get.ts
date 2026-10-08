import { defineEventHandler } from 'h3'
import { officeJournal } from '../../../core/office'
import { respond } from '../../../server/utils/api'

/** Technical log for the settings screen: events and jobs in plain words. */
export default defineEventHandler(() => respond(() => officeJournal()))
