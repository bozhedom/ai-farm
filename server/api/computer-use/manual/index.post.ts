import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { startManual, stopManual } from '../../../../core/computer-use/manual'
import { computerUseView } from '../../../../core/computer-use/view'
import { body, respond } from '../../../utils/api'
/** Owner remote control: take the browser (the model pauses) or hand it back. */
export default defineEventHandler((event) =>
  respond(async () => {
    const { action } = await body(
      event,
      z.object({ action: z.enum(['start', 'extend', 'stop']) }).strict(),
    )
    if (action === 'stop') await stopManual()
    else await startManual()
    return computerUseView()
  }),
)
