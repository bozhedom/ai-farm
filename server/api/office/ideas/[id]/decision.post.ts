import { defineEventHandler, getRouterParam } from 'h3'
import { decideIdea, ideaActionSchema } from '../../../../../core/idea-actions'
import { body, respond } from '../../../../utils/api'
export default defineEventHandler((event) =>
  respond(async () =>
    decideIdea(String(getRouterParam(event, 'id') ?? ''), await body(event, ideaActionSchema)),
  ),
)
