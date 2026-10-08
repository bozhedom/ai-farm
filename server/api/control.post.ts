import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { audit, query, transaction } from '../../core/db'
import { enqueue, requestResearch } from '../../core/queue'
import { templateSchema } from '../../core/policy'
import { body, respond } from '../utils/api'
import { setResearchScope, setSchedule } from '../../core/autonomy'
import { cancelResearchCampaign, requestResearchCampaign } from '../../core/research-campaign'
export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(
      event,
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('research'), template: templateSchema.optional() }).strict(),
        z.object({ action: z.literal('research_all') }).strict(),
        z.object({ action: z.literal('cancel_research_all'), campaignId: z.uuid() }).strict(),
        z
          .object({ action: z.literal('research_scope'), scope: z.enum(['rotate', 'all']) })
          .strict(),
        z
          .object({
            action: z.enum([
              'evaluate',
              'running',
              'paused',
              'emergency_stop',
              'restart_research',
              'schedule_on',
              'schedule_off',
            ]),
          })
          .strict(),
      ]),
    )
    if (input.action === 'research') return requestResearch(input.template)
    if (input.action === 'research_all') return requestResearchCampaign()
    if (input.action === 'cancel_research_all') return cancelResearchCampaign(input.campaignId)
    if (input.action === 'research_scope') return setResearchScope(input.scope)
    if (input.action === 'schedule_on' || input.action === 'schedule_off')
      return setSchedule(input.action === 'schedule_on')
    if (input.action === 'evaluate')
      return enqueue('evaluate', `evaluate:${Math.floor(Date.now() / (7 * 86400000))}`)
    if (input.action === 'restart_research')
      return transaction(async (db) => {
        await query(
          'UPDATE system_state SET research_enabled=true,generation_started_at=now() WHERE id=true',
          [],
          db,
        )
        await audit(
          'research_restarted',
          'Владелец открыл новое 28-дневное окно исследований.',
          {},
          db,
        )
        return { ok: true }
      })
    return transaction(async (db) => {
      await query('UPDATE system_state SET mode=$1 WHERE id=true', [input.action], db)
      await audit('control', 'Владелец изменил режим работы.', { mode: input.action }, db)
      return { mode: input.action }
    })
  }),
)
