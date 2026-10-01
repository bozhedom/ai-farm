import { defineEventHandler, setResponseStatus } from 'h3'
import { serviceReadiness } from '../../core/operations'

export default defineEventHandler(async (event) => {
  const state = await serviceReadiness()
  if (state.status !== 'ok') setResponseStatus(event, 503)
  return state
})
