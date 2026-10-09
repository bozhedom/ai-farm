import { config } from '../config'
import { isDemoStand } from '../stand'
import { audit, query } from '../db'
import { closeReservation, reserveBudget } from '../budget'
import { model, search, searchQuery } from '../providers'
import { demoReplyDraft } from '../providers/demo'
import {
  POLICY,
  replyDraftSchemaFor,
  templateSchema,
  validateReplyDraft,
  type Evidence,
  type Template,
} from '../policy'
import type { Job } from '../queue'
import { requestText, selectCustomerCandidates, staleLead } from '../customer-discovery'
import { serviceName } from '../service-names'
import { saveOpportunities } from '../opportunities'
import { topicById } from '../taxonomy'
import { formatRub, publicSlug } from '../storefront'
import { errorCode, mustPropagate, withLease } from './lease'

type ProductRow = {
  id: string
  template: Template
  slug: string
  status: string
  visibility: string
  is_demo: boolean
  spec: { name?: string; promise?: string }
  price_kopecks: number
  topic_id: string | null
}

export function publicProductUrl(slug: string) {
  return `${new URL(config().APP_ORIGIN).origin}/services/${publicSlug(slug)}`
}

/** The model sees the topic of a request, not a person: no source URL, names cut away. */
export function leadTopic(title: string) {
  const clean = title
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (run) => (run.replace(/\D/g, '').length >= 9 ? '' : run))
    .trim()
  const match = requestText.exec(clean.toLowerCase())
  return (match ? clean.slice(match.index) : clean).trim().slice(0, 120)
}

async function loadProduct(id: string) {
  const [row] = await query<ProductRow>(
    `SELECT p.id,p.template,p.slug,p.status,p.visibility,p.is_demo,p.spec,p.price_kopecks,i.topic_id
     FROM products p LEFT JOIN ideas i ON i.id=p.idea_id WHERE p.id=$1`,
    [id],
  )
  return row
}

/**
 * Replies point buyers at the product page: only products buyers can open qualify. A demo
 * product is hidden from the site on a stand with a real model, so it gets no replies there.
 */
function onStorefront(product: ProductRow) {
  return (
    product.status === 'sandbox' &&
    product.visibility === 'public' &&
    (!product.is_demo || isDemoStand())
  )
}

/** Drafts made today across all products: a daily cap, not a per-job one. */
async function draftsLeft() {
  const [row] = await query(
    `SELECT count(*)::int AS n FROM opportunities
     WHERE reply_drafted_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
  )
  const cap = Math.min(config().LEAD_DRAFTS_PER_DAY, POLICY.maxLeadDraftsPerDay)
  return Math.max(0, cap - (row!.n as number))
}

/**
 * One "Автор отклика" call and the server check. A rejected draft is not saved: the reason goes
 * to reply_error. The farm never sends anything; the owner copies the text by hand.
 */
async function draftReply(
  job: Job,
  reservationId: string,
  product: ProductRow,
  lead: { id: string; title: string; snippet: string },
) {
  const publicUrl = publicProductUrl(product.slug)
  const name = serviceName(product.template, product.spec.name || product.template)
  const promise = product.spec.promise || ''
  let draft: string | null = null
  let failure: string | null = null
  try {
    const value = await model({
      role: 'Автор отклика',
      key: `${job.id}:draft:${lead.id}`,
      reservationId,
      context: {
        product: {
          name,
          promise,
          priceRub: formatRub(product.price_kopecks),
          publicUrl,
        },
        lead: { title: leadTopic(lead.title), snippet: lead.snippet.slice(0, 500) },
        rules: [
          'Короткий вежливый отклик на публичный запрос: 2-5 предложений.',
          'Скажи, чем продукт поможет именно в этом запросе, и дай ссылку publicUrl.',
          'Не обращайся по имени, не пиши email, телефоны, @-упоминания и другие ссылки.',
          'Не обещай скидки, гарантии, бесплатную работу и сроки, которых нет в продукте.',
          'Текст отправит человек. Не пиши, что ферма уже связалась с заказчиком.',
        ],
        task: 'Подготовь черновик отклика в поле draft.',
      },
      schema: replyDraftSchemaFor(publicUrl, `${name} ${promise}`, `${lead.title} ${lead.snippet}`),
      demoValue: {
        draft: demoReplyDraft({ name, promise, priceKopecks: product.price_kopecks, publicUrl }),
      },
    })
    draft = validateReplyDraft(
      value.draft,
      publicUrl,
      `${name} ${promise}`,
      `${lead.title} ${lead.snippet}`,
    )
  } catch (error) {
    if (mustPropagate(error)) throw error
    failure = errorCode(error, 'REPLY_DRAFT_FAILED')
  }
  await withLease(job, async (db) => {
    if (draft) {
      const [row] = await query(
        `UPDATE opportunities SET reply_draft=$2,reply_drafted_at=now(),reply_job_id=$3,reply_error=null,
         product_id=COALESCE(product_id,$4),updated_at=now() WHERE id=$1 RETURNING url,title,is_demo`,
        [lead.id, draft, job.id, product.id],
        db,
      )
      await audit(
        'lead_draft_ready',
        'Найден возможный клиент. Отклик готов, отправляете вы.',
        {
          opportunityId: lead.id,
          productId: product.id,
          host: row ? new URL(row.url).hostname.replace(/^www\./, '') : null,
          title: leadTopic(lead.title),
          isDemo: row?.is_demo ?? false,
        },
        db,
      )
    } else
      await query(
        'UPDATE opportunities SET reply_error=$2,updated_at=now() WHERE id=$1',
        [lead.id, failure],
        db,
      )
  })
  return !!draft
}

/** `lead:<day>:<productId>`: search public requests for a product and draft a few replies. */
export async function lead(job: Job) {
  if (job.payload.opportunityId) return leadDraft(job)
  const product = await loadProduct(job.payload.productId || '')
  if (!product) throw new Error('INPUT_PRODUCT_UNKNOWN')
  // Replies point buyers at the product page: only products on the storefront qualify.
  if (!onStorefront(product)) return
  templateSchema.parse(product.template)
  const reservationId = await reserveBudget(`lead:${job.id}`, 'lead')
  const evidence = await search(product.template, `${job.id}:customers`, reservationId, 'customers')
  let candidates: Evidence[] = selectCustomerCandidates(product.template, evidence)
  const topic = product.topic_id ? topicById[product.topic_id] : undefined
  if (topic) {
    const extra = await searchQuery(
      topic.queries[0],
      `${job.id}:customers-topic`,
      reservationId,
      'customers',
    )
    for (const item of selectCustomerCandidates(product.template, extra))
      if (!candidates.some((c) => c.url === item.url)) candidates.push(item)
  }
  candidates = candidates.slice(0, 6)
  const saved = await saveOpportunities(job.id, product.template, candidates, product.id)
  let room = await draftsLeft()
  const pending = room
    ? await query(
        `SELECT id,title,snippet FROM opportunities
         WHERE (product_id=$1 OR (product_id IS NULL AND template=$2)) AND reply_draft IS NULL
         AND reply_error IS NULL AND stage='new' AND (NOT is_demo OR $4)
         ORDER BY first_seen_at,id LIMIT $3`,
        [product.id, product.template, room + 20, isDemoStand()],
      )
    : []
  let drafted = 0
  for (const item of pending) {
    if (room <= 0) break
    // Closed or old requests saved earlier get no reply and do not use the daily limit.
    const stale = staleLead(item.title, item.snippet)
    if (stale) {
      await query('UPDATE opportunities SET reply_error=$2,updated_at=now() WHERE id=$1', [
        item.id,
        stale,
      ])
      continue
    }
    if (await draftReply(job, reservationId, product, item as any)) drafted++
    room--
  }
  await audit('lead_search_completed', 'Поиск клиентов по продукту завершён.', {
    jobId: job.id,
    productId: product.id,
    examined: evidence.length,
    matched: candidates.length,
    saved,
    drafted,
    isDemo: config().SEARCH_PROVIDER === 'demo',
  })
  await closeReservation(reservationId)
}

/** `lead-draft:<opportunityId>:<n>`: the owner asked for a new draft for one lead. */
async function leadDraft(job: Job) {
  const [item] = await query(
    'SELECT id,title,snippet,template,product_id FROM opportunities WHERE id=$1',
    [job.payload.opportunityId],
  )
  if (!item) throw new Error('INPUT_OPPORTUNITY_UNKNOWN')
  const productId =
    item.product_id ||
    (
      await query(
        `SELECT id FROM products WHERE template=$1 AND status='sandbox' AND visibility='public'
         AND (NOT is_demo OR $2) ORDER BY published_at DESC NULLS LAST,id LIMIT 1`,
        [item.template, isDemoStand()],
      )
    )[0]?.id
  const product = productId ? await loadProduct(productId) : undefined
  if (!product) throw new Error('INPUT_PRODUCT_UNKNOWN')
  if (!onStorefront(product)) throw new Error('INPUT_PRODUCT_NOT_PUBLIC')
  const reservationId = await reserveBudget(`lead:${job.id}`, 'lead')
  const ok = await draftReply(job, reservationId, product, item as any)
  if (!ok)
    await audit('lead_draft_rejected', 'Отклик не прошёл проверку и не сохранён.', {
      jobId: job.id,
      opportunityId: item.id,
      productId: product.id,
    })
  await closeReservation(reservationId)
}
