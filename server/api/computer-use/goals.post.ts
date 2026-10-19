import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { addOwnerGoal } from '../../../core/computer-use/runtime'
import { computerUseView } from '../../../core/computer-use/view'
import { body, respond } from '../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const { goal } = await body(event, z.object({ goal: z.string().max(1000) }).strict())
    const id = await addOwnerGoal(goal)
    return { id, ...(await computerUseView()) }
  }),
)
