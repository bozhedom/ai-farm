import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { audit, query, transaction } from '../../core/db'
import { enqueue } from '../../core/queue'
import { simulateEvolution } from '../../core/evolution'
import { body, respond } from '../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(
      event,
      z.discriminatedUnion('action', [
        z
          .object({
            action: z.enum(['research', 'evaluate', 'running', 'paused', 'emergency_stop']),
          })
          .strict(),
        z
          .object({ action: z.literal('simulate'), generation: z.number().int().positive() })
          .strict(),
      ]),
    )
    if (input.action === 'research')
      return enqueue('research', `research:${new Date().toISOString().slice(0, 10)}`)
    if (input.action === 'evaluate')
      return enqueue('evaluate', `evaluate:${Math.floor(Date.now() / (7 * 86400000))}`)
    if (input.action === 'simulate') return simulateEvolution(input.generation)
    return transaction(async (db) => {
      await query('UPDATE system_state SET mode=$1 WHERE id=true', [input.action], db)
      await audit('control', 'Владелец изменил режим работы.', { mode: input.action }, db)
      return { mode: input.action }
    })
  }),
)
