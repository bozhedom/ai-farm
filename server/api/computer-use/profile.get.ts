import { defineEventHandler } from 'h3'
import { profileView } from '../../../core/computer-use/profile'
import { respond } from '../../utils/api'
/** The owner's performer profile with its limits; owner session only (server middleware). */
export default defineEventHandler(() => respond(profileView))
