import { defineEventHandler, getRouterParam } from 'h3'
import { setProductVisibility, visibilitySchema } from '../../../../../core/office'
import { body, respond } from '../../../../../server/utils/api'

export default defineEventHandler((event) =>
  respond(async () =>
    setProductVisibility(
      String(getRouterParam(event, 'id') ?? ''),
      await body(event, visibilitySchema),
    ),
  ),
)
