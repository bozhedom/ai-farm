import { defineEventHandler } from 'h3'
import { manualAct } from '../../../../core/computer-use/manual'
import { browserActionSchema } from '../../../../core/computer-use/schema'
import { body, respond } from '../../../utils/api'
/**
 * One owner action on the owner's own VM session: click, type, key, navigate, scroll, back.
 * Validated like model actions but not classified: the owner may log in. Typed text is never
 * stored; the model never sees these actions.
 */
export default defineEventHandler((event) =>
  respond(async () => {
    const action = await body(event, browserActionSchema)
    return manualAct(action)
  }),
)
