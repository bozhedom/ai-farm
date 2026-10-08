import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit, query, transaction } from './db'
import {
  safeSourceUrl,
  templateSchema,
  validateContent,
  type Evidence,
  type Template,
} from './policy'
import { search } from './providers'
import { selectCustomerCandidates } from './customer-discovery'

export const opportunityUpdateSchema = z
  .object({
    stage: z.enum(['new', 'saved', 'contacted', 'won', 'dismissed']),
    note: z.string().trim().max(1000).default(''),
  })
  .strict()

/** Store only public search snippets. A result is a candidate, never a verified customer. */
export async function saveOpportunities(
  jobId: string,
  template: Template,
  evidence: Evidence[],
  productId: string | null = null,
) {
  templateSchema.parse(template)
  const candidates = evidence.slice(0, 6).flatMap((item) => {
    if (!safeSourceUrl(item.url)) return []
    try {
      validateContent(`${item.title} ${item.snippet}`)
    } catch {
      return []
    }
    const url = new URL(item.url)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|yclid$|gclid$|fbclid$)/i.test(key)) url.searchParams.delete(key)
    }
    // Contact collection is deliberately outside this discovery step.
    const redact = (text: string) =>
      text
        .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[контакт в источнике]')
        // Any phone-like run of nine digits or more: +7, 8 (999), dots and dashes.
        .replace(/\+?\d[\d\s().-]{7,}\d/g, (run) =>
          run.replace(/\D/g, '').length >= 9 ? '[контакт в источнике]' : run,
        )
    const title = redact(item.title).slice(0, 300).trim()
    const snippet = redact(item.snippet).slice(0, 1000).trim()
    if (!title || !snippet) return []
    return [{ url: url.toString(), title, snippet, demo: item.demo }]
  })
  return transaction(async (db) => {
    let saved = 0
    for (const item of candidates) {
      const rows = await query(
        `INSERT INTO opportunities(id,template,url,title,snippet,is_demo,first_job_id,last_job_id,product_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)
         ON CONFLICT(template,url,is_demo) DO UPDATE SET
           title=EXCLUDED.title,snippet=EXCLUDED.snippet,last_seen_at=now(),last_job_id=EXCLUDED.last_job_id,
           product_id=COALESCE(opportunities.product_id,EXCLUDED.product_id)
         WHERE opportunities.last_job_id<>EXCLUDED.last_job_id
           AND (SELECT (created_at,id) FROM jobs WHERE id=opportunities.last_job_id)
             < (SELECT (created_at,id) FROM jobs WHERE id=EXCLUDED.last_job_id)
         RETURNING id`,
        [randomUUID(), template, item.url, item.title, item.snippet, item.demo, jobId, productId],
        db,
      )
      saved += rows.length
    }
    if (saved)
      await audit(
        'opportunities_discovered',
        'Найдены потенциальные запросы на услуги. Актуальность и интерес заказчиков требуют проверки.',
        { jobId, template, saved, productId, demo: candidates.every((item) => item.demo) },
        db,
      )
    return saved
  })
}

export async function discoverOpportunities(
  jobId: string,
  template: Template,
  reservationId: string,
) {
  try {
    const evidence = await search(
      template,
      `${jobId}:${template}:customers`,
      reservationId,
      'customers',
    )
    const candidates = selectCustomerCandidates(template, evidence)
    await saveOpportunities(jobId, template, candidates)
    await audit(
      'opportunities_search_completed',
      candidates.length
        ? 'Отобраны источники с признаками запроса на услугу; актуальность проверяет владелец.'
        : 'В выдаче нет подходящих запросов на услугу. Пустой список не подтверждает отсутствие спроса.',
      { jobId, template, examined: evidence.length, matched: candidates.length },
    )
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
        ? error.message
        : 'CUSTOMER_SEARCH_FAILED'
    await audit(
      'opportunities_search_failed',
      'Поиск потенциальных заказчиков не завершён. Исследование гипотезы продолжается в прежних лимитах.',
      { jobId, template, code },
    )
    // Metered search already retained any ambiguous charge; do not retry it under another key.
  }
}

export const opportunityListSchema = z
  .object({
    stage: opportunityUpdateSchema.shape.stage.optional(),
    template: templateSchema.optional(),
    offset: z.coerce.number().int().min(0).max(100000000).default(0),
  })
  .strict()

export async function opportunityList(filter: z.input<typeof opportunityListSchema> = {}) {
  const input = opportunityListSchema.parse(filter)
  const limit = 50
  const values = [input.stage ?? null, input.template ?? null]
  const condition = 'WHERE ($1::text IS NULL OR stage=$1) AND ($2::text IS NULL OR template=$2)'
  const [items, totals] = await Promise.all([
    query(
      `SELECT id,template,url,title,snippet,is_demo,stage,note,first_seen_at,last_seen_at,
        product_id,reply_draft,reply_drafted_at,reply_error
      FROM opportunities ${condition} ORDER BY CASE stage WHEN 'new' THEN 0 WHEN 'saved' THEN 1
      WHEN 'contacted' THEN 2 WHEN 'won' THEN 3 ELSE 4 END,last_seen_at DESC,id LIMIT $3 OFFSET $4`,
      [...values, limit, input.offset],
    ),
    query(`SELECT count(*)::int AS total FROM opportunities ${condition}`, values),
  ])
  const total = totals[0]!.total as number
  return { items, total, offset: input.offset, limit, hasMore: input.offset + items.length < total }
}

export async function updateOpportunity(id: string, value: unknown) {
  const input = opportunityUpdateSchema.parse(value)
  return transaction(async (db) => {
    const [old] = await query('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id], db)
    if (!old) throw new Error('OPPORTUNITY_NOT_FOUND')
    if (old.stage === input.stage && old.note === input.note) return { id, ...input }
    await query(
      'UPDATE opportunities SET stage=$2,note=$3,updated_at=now() WHERE id=$1',
      [id, input.stage, input.note],
      db,
    )
    await audit(
      'opportunity_updated',
      'Владелец обновил статус потенциального заказчика. Платёжные записи не изменялись.',
      { id, from: old.stage, to: input.stage },
      db,
    )
    return { id, ...input }
  })
}
