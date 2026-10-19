import { z } from 'zod'
import { config } from '../core/config'
import { model } from '../core/providers'
import { reserveBudget, closeReservation } from '../core/budget'
import { query, pool, audit } from '../core/db'

// A fixed idempotency key makes accidental reruns reuse the result, never rebill the probe.
// OpenRouter is a separate account, so its probe has its own key.
const key =
  process.env.OPENAI_TRANSPORT === 'openrouter'
    ? 'openrouter-astra-connection-check-v1'
    : 'openai-connection-check-v1'
try {
  const c = config()
  if (
    c.MODEL_PROVIDER !== 'openai' ||
    c.AUTONOMY_ENABLED ||
    c.OPENAI_TOTAL_BUDGET_MICROUSD > 1000000
  )
    throw new Error('CLOUD_CHECK_REQUIRES_MANUAL_MODE_AND_ONE_DOLLAR_CAP')
  const [previous] = await query('SELECT status FROM tool_calls WHERE call_key=$1', [key])
  if (previous && previous.status !== 'done') throw new Error('UNCERTAIN_CALL_REQUIRES_REVIEW')
  if (!previous) {
    const reservationId = await reserveBudget(key, 'order')
    try {
      await model({
        role: 'Проверка подключения',
        key,
        reservationId,
        maxOutputTokens: 128,
        context: { task: 'Проверка соединения. Верни {"ok":true}.' },
        schema: z.object({ ok: z.literal(true) }).strict(),
        demoValue: { ok: true },
      })
      await audit('cloud_check', 'Ограниченный запрос к платной модели прошёл проверку.', {
        callKey: key,
      })
    } finally {
      await closeReservation(reservationId)
    }
  }
  console.log(
    JSON.stringify(
      (
        await query(
          'SELECT status,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,reasoning_tokens,actual_microusd,charged_microusd FROM tool_calls WHERE call_key=$1',
          [key],
        )
      )[0],
    ),
  )
} finally {
  await pool.end()
}
