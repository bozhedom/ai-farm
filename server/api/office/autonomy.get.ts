import { defineEventHandler } from 'h3'
import { autonomyView } from '../../../core/autopilot'
import { respond } from '../../../server/utils/api'

/** Owner only: the autopilot's last decisions, worker loop heartbeats and budget pacing. */
export default defineEventHandler(() => respond(() => autonomyView()))
