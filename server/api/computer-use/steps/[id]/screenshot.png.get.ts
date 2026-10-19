import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { z } from 'zod'
import { query } from '../../../../../core/db'
import { readScreenshot } from '../../../../../core/computer-use/runtime'

/** The stored PNG of one step. Owner session only (security middleware); never cached. */
export default defineEventHandler(async (event) => {
  const id = z.uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) throw createError({ statusCode: 404, statusMessage: 'SCREENSHOT_NOT_FOUND' })
  const [step] = await query(
    'SELECT screenshot_path FROM computer_use_steps WHERE id=$1 AND screenshot_path IS NOT NULL',
    [id.data],
  )
  const png = step ? await readScreenshot(step.screenshot_path) : null
  if (!png) throw createError({ statusCode: 404, statusMessage: 'SCREENSHOT_NOT_FOUND' })
  setHeader(event, 'Content-Type', 'image/png')
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Content-Security-Policy', "default-src 'none'")
  return png
})
