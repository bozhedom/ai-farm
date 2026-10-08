import { defineEventHandler, getRouterParam } from 'h3'
import { ideaUpdateSchema, updateIdea } from '../../../../core/office'
import { body, respond } from '../../../../server/utils/api'

export default defineEventHandler((event) =>
  respond(async () =>
    updateIdea(String(getRouterParam(event, 'id') ?? ''), await body(event, ideaUpdateSchema)),
  ),
)
