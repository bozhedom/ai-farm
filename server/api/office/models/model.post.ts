import { defineEventHandler } from 'h3'
import { modelSelectionSchema, saveModelSelection } from '../../../../core/agent-profiles'
import { body, respond } from '../../../utils/api'

export default defineEventHandler((event) =>
  respond(async () => saveModelSelection(await body(event, modelSelectionSchema))),
)
