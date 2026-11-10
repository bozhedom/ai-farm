import { z } from 'zod'
import { config } from '../config'
import { audit, query, transaction } from '../db'
import { openrouterCost } from '../providers/openrouter'

const receiptSchema = z.object({
  id: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  total_cost: z.union([z.number().nonnegative(), z.string()]),
  native_tokens_prompt: z.number().int().nonnegative().max(100000),
  native_tokens_completion: z.number().int().positive().max(2800),
  finish_reason: z.literal('length'),
})
async function readReceipt(id: string): Promise<unknown> {
  const c = config()
  if (c.OPENAI_TRANSPORT !== 'openrouter' || !c.OPENROUTER_API_KEY)
    throw new Error('MANAGER_RECEIPT_UNAVAILABLE')
  const response = await fetch(
    'https://openrouter.ai/api/v1/generation?id=' + encodeURIComponent(id),
    {
      headers: { Authorization: `Bearer ${c.OPENROUTER_API_KEY}` },
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    },
  )
  if (!response.ok) throw new Error('MANAGER_RECEIPT_UNAVAILABLE')
  const text = await response.text()
  if (text.length > 100000) throw new Error('MANAGER_RECEIPT_INVALID')
  return JSON.parse(text).data
}
/** Operator-only CLI: confirm a completed, truncated generation against the provider receipt.
 * Keep the conservative charge, failed run and call key intact. Never retries the old call.
 */
export async function reviewManagerTruncation(callId: string, receiptReader = readReceipt) {
  z.uuid().parse(callId)
  const [before] = await query('SELECT provider_response_id FROM tool_calls WHERE id=$1', [callId])
  if (!before?.provider_response_id) throw new Error('MANAGER_RECEIPT_INVALID')
  const receipt = receiptSchema.parse(await receiptReader(before.provider_response_id))
  const cost = openrouterCost(receipt.total_cost)
  return transaction(async (db) => {
    const [call] = await query(
      `SELECT t.*,r.category FROM tool_calls t JOIN budget_reservations r ON r.id=t.reservation_id WHERE t.id=$1 FOR UPDATE OF t`,
      [callId],
      db,
    )
    const dated =
      call &&
      receipt.model.startsWith(call.model + '-') &&
      /^\d{8}$/.test(receipt.model.slice(call.model.length + 1))
    if (
      !call ||
      call.category !== 'trading_manager' ||
      call.provider !== 'openai' ||
      call.is_demo ||
      call.status !== 'uncertain' ||
      call.error_code !== 'MODEL_OUTPUT_INCOMPLETE' ||
      call.provider_response_id !== receipt.id ||
      (receipt.model !== call.model && !dated) ||
      call.input_tokens !== receipt.native_tokens_prompt ||
      call.output_tokens !== receipt.native_tokens_completion ||
      call.actual_microusd === null ||
      cost > call.actual_microusd ||
      call.actual_microusd > call.charged_microusd
    )
      throw new Error('MANAGER_RECEIPT_MISMATCH')
    const rows = await query(
      `INSERT INTO trading_manager_cost_reviews(call_id,provider_response_id,actual_microusd,charged_microusd,receipt)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING call_id`,
      [callId, receipt.id, call.actual_microusd, call.charged_microusd, receipt],
      db,
    )
    if (rows.length)
      await audit(
        'trading_manager_cost_reviewed',
        'Стоимость обрезанного ответа сверена с квитанцией OpenRouter. Верхняя оценка сохранена; повтор прежнего вызова запрещён.',
        {
          callId,
          providerResponseId: receipt.id,
          receiptMicrousd: cost,
          chargedMicrousd: call.charged_microusd,
        },
        db,
      )
    return {
      callId,
      receiptMicrousd: cost,
      chargedMicrousd: call.charged_microusd,
      recorded: !!rows.length,
    }
  })
}
