import { randomUUID } from 'node:crypto'
import { audit, query, transaction, type Connection } from './db'
import { config } from './config'
import { templates } from './policy'
import { enqueue } from './queue'

/** A bounded portfolio sweep: one durable job and one budget reservation per direction. */
export async function requestResearchCampaign() {
  return transaction((db) => enqueueResearchCampaign(db))
}

/** Called inside the scheduler transaction so the UTC slot and all directions commit together. */
export async function enqueueResearchCampaign(db: Connection, scheduledSlot?: string) {
  const [state] = await query('SELECT * FROM system_state WHERE id=true FOR UPDATE', [], db)
  if (state?.mode !== 'running') throw new Error('RESEARCH_PAUSED')
  if (!state.research_enabled) throw new Error('RESEARCH_WINDOW_CLOSED')
  const scheduleEnabled = config().AUTONOMY_ENABLED && state.schedule_enabled
  if (scheduledSlot && !scheduleEnabled) throw new Error('RESEARCH_CAMPAIGN_SCHEDULE_PAUSED')
  const [active] = await query(
    `SELECT id,status,payload->>'campaignId' AS campaign_id,payload->>'scheduleSlot' AS schedule_slot
     FROM jobs WHERE kind='research' AND payload ? 'campaignId' AND status IN ('queued','running')
     ORDER BY created_at,payload->>'campaignPosition',id LIMIT 1`,
    [],
    db,
  )
  if (active) {
    if (!scheduledSlot && active.schedule_slot && !scheduleEnabled)
      throw new Error('RESEARCH_CAMPAIGN_SCHEDULE_PAUSED')
    return {
      id: active.id as string,
      campaignId: active.campaign_id as string,
      status: active.status as string,
      existing: true,
    }
  }
  if (scheduledSlot) {
    const [previous] = await query(
      `SELECT id,status,payload->>'campaignId' AS campaign_id FROM jobs WHERE dedupe_key=$1`,
      [scheduledSlot],
      db,
    )
    if (previous) {
      if (!previous.campaign_id) throw new Error('RESEARCH_SLOT_ALREADY_USED')
      return {
        id: previous.id as string,
        campaignId: previous.campaign_id as string,
        status: previous.status as string,
        existing: true,
      }
    }
  }
  const campaignId = randomUUID()
  let firstId = ''
  for (const [index, template] of templates.entries()) {
    const job = await enqueue(
      'research',
      index === 0 && scheduledSlot ? scheduledSlot : `campaign-research:${campaignId}:${template}`,
      {
        campaignId,
        campaignPosition: String(index + 1).padStart(2, '0'),
        templates: JSON.stringify([template]),
        ...(scheduledSlot ? { scheduleSlot: scheduledSlot } : {}),
      },
      db,
    )
    firstId ||= job.id as string
  }
  await audit(
    scheduledSlot ? 'research_campaign_scheduled' : 'research_campaign_requested',
    scheduledSlot
      ? 'Расписание поставило последовательное исследование всех разрешённых направлений.'
      : 'Владелец запустил последовательное исследование всех разрешённых направлений.',
    { campaignId, templates: [...templates], total: templates.length, scheduledSlot },
    db,
  )
  return { id: firstId, campaignId, status: 'queued', existing: false }
}

/** Cancelling future research never interrupts an external call or changes customer orders. */
export async function cancelResearchCampaign(campaignId: string) {
  return transaction(async (db) => {
    await query('SELECT id FROM system_state WHERE id=true FOR UPDATE', [], db)
    const exists = await query(
      "SELECT id FROM jobs WHERE kind='research' AND payload->>'campaignId'=$1 LIMIT 1",
      [campaignId],
      db,
    )
    if (!exists.length) throw new Error('RESEARCH_CAMPAIGN_NOT_FOUND')
    const cancelled = await query(
      `UPDATE jobs SET status='failed',error_code='RESEARCH_CAMPAIGN_CANCELLED',finished_at=now()
       WHERE kind='research' AND payload->>'campaignId'=$1 AND status='queued' RETURNING id`,
      [campaignId],
      db,
    )
    if (cancelled.length) {
      await query(
        `UPDATE budget_reservations SET status='closed'
         WHERE dedupe_key=ANY($1::text[])`,
        [cancelled.map((job) => `research:${job.id}`)],
        db,
      )
      await audit(
        'research_campaign_cancelled',
        'Оставшиеся направления отменены владельцем. Начатое исследование может завершиться.',
        { campaignId, cancelled: cancelled.length },
        db,
      )
    }
    return { campaignId, cancelled: cancelled.length }
  })
}

export async function researchCampaignStatus(campaignId?: string) {
  if (!campaignId) {
    const [latest] = await query(
      `SELECT payload->>'campaignId' AS id FROM jobs
       WHERE kind='research' AND payload ? 'campaignId' ORDER BY created_at DESC,id DESC LIMIT 1`,
    )
    if (!latest) return null
    campaignId = latest.id as string
  }
  const rows = await query(
    `SELECT j.id,j.status,j.error_code,j.created_at,j.finished_at,j.run_after,j.payload,
       h.status AS hypothesis_status,v.product_id
     FROM jobs j
     LEFT JOIN LATERAL (
       SELECT id,status FROM hypotheses WHERE job_id=j.id ORDER BY created_at DESC LIMIT 1
     ) h ON true
     LEFT JOIN product_versions v ON v.hypothesis_id=h.id
     WHERE j.kind='research' AND j.payload->>'campaignId'=$1
     ORDER BY j.payload->>'campaignPosition',j.created_at,j.id`,
    [campaignId],
  )
  if (!rows.length) return null
  const items = rows.map((row) => ({
    id: row.id as string,
    template: (JSON.parse(row.payload.templates) as string[])[0]!,
    status: row.status as string,
    errorCode: row.error_code as string | null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    runAfter: row.run_after,
    hypothesisStatus: row.hypothesis_status as string | null,
    productId: row.product_id as string | null,
  }))
  const count = (status: string) => items.filter((item) => item.status === status).length
  const pending = count('queued')
  const running = count('running')
  const cancelled = items.filter((item) => item.errorCode === 'RESEARCH_CAMPAIGN_CANCELLED').length
  return {
    id: campaignId,
    source: rows[0]!.payload.scheduleSlot ? 'scheduled' : 'manual',
    scheduleSlot: (rows[0]!.payload.scheduleSlot as string | undefined) ?? null,
    createdAt: rows[0]!.created_at,
    total: items.length,
    completed: count('done'),
    failed: count('failed') - cancelled,
    cancelled,
    pending,
    running,
    status: pending + running > 0 ? 'running' : cancelled > 0 ? 'cancelled' : 'done',
    items,
  }
}
