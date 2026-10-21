import { defineEventHandler } from 'h3'
import { launchView } from '../../../core/launch/view'
import { respond } from '../../../server/utils/api'

/** Owner only: the launch checklist, what is left so the farm earns by itself. */
export default defineEventHandler(() => respond(() => launchView()))
