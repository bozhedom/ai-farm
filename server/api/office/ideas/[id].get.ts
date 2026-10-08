import { defineEventHandler, getRouterParam } from 'h3'
import { officeIdea } from '../../../../core/office'
import { respond } from '../../../../server/utils/api'

export default defineEventHandler((event) =>
  respond(() => officeIdea(String(getRouterParam(event, 'id') ?? ''))),
)
