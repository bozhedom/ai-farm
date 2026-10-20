import { createError, defineEventHandler, setHeader } from 'h3'
import { manualScreenshot } from '../../../../core/computer-use/manual'

/** A live screenshot of the owner's VM session. Owner session only; never stored or cached. */
export default defineEventHandler(async (event) => {
  let shot: Awaited<ReturnType<typeof manualScreenshot>>
  try {
    shot = await manualScreenshot()
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
        ? error.message
        : 'INTERNAL_ERROR'
    throw createError({
      statusCode: code === 'COMPUTER_USE_MANUAL_NOT_ACTIVE' ? 409 : 503,
      statusMessage: code,
    })
  }
  setHeader(event, 'Content-Type', 'image/png')
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Content-Security-Policy', "default-src 'none'")
  setHeader(event, 'X-Page-Url', encodeURI(shot.url).slice(0, 2000))
  return shot.png
})
