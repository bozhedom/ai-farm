import { defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import { serviceJob } from '../../../../core/services/store'
import { respond } from '../../../utils/api'

export default defineEventHandler((event) =>
  respond(() => serviceJob(z.uuid().parse(getRouterParam(event, 'id')))),
)
