import { defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import { requestLeadDraft } from '../../../../../core/office'
import { body, respond } from '../../../../../server/utils/api'

/** A new reply draft. The farm never sends it; the owner copies the text. */
export default defineEventHandler((event) =>
  respond(async () => {
    await body(event, z.object({}).strict().optional())
    return requestLeadDraft(String(getRouterParam(event, 'id') ?? ''))
  }),
)
