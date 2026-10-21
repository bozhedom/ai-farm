import { defineEventHandler } from 'h3'
import { computerUseView } from '../../../../core/computer-use/view'
import { respond } from '../../../utils/api'
/** The search directions alone; the full office view carries the same list. */
export default defineEventHandler(() =>
  respond(async () => ({ directions: (await computerUseView()).directions })),
)
