import { randomUUID } from 'node:crypto'
import { config } from '../config'
import { audit, pool, query, transaction, type Connection } from '../db'
import { orderBudgetAvailable } from '../budget'
import { checkProductInput, insertOrder, requestKeyHash } from '../orders'
import { invoiceUnique, invoiceWei } from '../public-orders'
import { validateInput } from '../policy'
import { serviceCatalog as definitions, serviceByTemplate } from '../service-catalog'
import type { ServiceTemplate } from '../service-catalog'
import {
  assertFreshServiceQuote,
  digest,
  readServiceQuote,
  serviceQuoteTtlMs,
  signServiceQuote,
} from './quote'
import type { ServiceCatalogView, ServiceJobView, ServiceQuoteView } from './types'

type Row = Record<string, any>
const fresh = (at: unknown, now: number) => {
  const age = now - new Date(String(at || '')).getTime()
  return Number.isFinite(age) && age >= 0 && age < 90000
}

function stateBlockers(state: Row | undefined, now: number) {
  const issues: { code: string; message: string }[] = []
  if (state?.mode !== 'running')
    issues.push({
      code: 'NEW_ORDERS_PAUSED',
      message: 'Студия приостановлена. Новые заказы закрыты.',
    })
  if (!fresh(state?.worker_heartbeat, now))
    issues.push({ code: 'SERVICE_WORKER_UNAVAILABLE', message: 'Обработчик заказов не отвечает.' })
  if (
    !fresh(state?.provider_readiness?.checkedAt, now) ||
    state?.provider_readiness?.model !== true
  )
    issues.push({
      code: 'SERVICE_MODEL_UNAVAILABLE',
      message: 'Готовность модели пока не подтверждена.',
    })
  return issues
}

async function assertAdmission(state: Row | undefined, db: Connection, now: number) {
  const issue = stateBlockers(state, now)[0]
  if (issue) throw new Error(issue.code)
  if (!(await query("SELECT id FROM strategies WHERE status='active' LIMIT 1", [], db)).length)
    throw new Error('NO_ACTIVE_STRATEGY')
  if (!(await orderBudgetAvailable(db))) throw new Error('BUDGET_BLOCKED')
}

function productDigest(product: Row) {
  // PostgreSQL JSONB has a stable key order; both calls read the persisted snapshot.
  return digest(
    JSON.stringify({
      id: product.id,
      template: product.template,
      version: product.version,
      spec: product.spec,
      priceKopecks: product.price_kopecks,
      isDemo: product.is_demo,
    }),
  )
}

async function offeredProduct(productId: string, db: Connection) {
  const [product] = await query(
    `SELECT * FROM products WHERE id=$1 AND status='sandbox'
     AND (NOT is_demo OR $2) FOR SHARE`,
    [productId, config().MODEL_PROVIDER === 'demo'],
    db,
  )
  if (!product || !serviceByTemplate[product.template as ServiceTemplate])
    throw new Error('PRODUCT_NOT_FOUND')
  return product
}

/** Lists contracts and existing products. Reading readiness never calls a model or network. */
export async function servicesCatalog(now = new Date()): Promise<ServiceCatalogView> {
  const c = config()
  const [products, states, active, available] = await Promise.all([
    query("SELECT * FROM products WHERE status='sandbox' ORDER BY version DESC,created_at DESC"),
    query('SELECT mode,worker_heartbeat,provider_readiness FROM system_state WHERE id=true'),
    query("SELECT id FROM strategies WHERE status='active' LIMIT 1"),
    orderBudgetAvailable(pool),
  ])
  const blockers = stateBlockers(states[0], now.getTime()).map((issue) => issue.message)
  if (!active.length) blockers.push('Нет активного исполнителя услуги.')
  if (!available) blockers.push('Недостаточно бюджета модели для нового заказа.')
  const services = definitions.map((definition) => {
    const product = products.find(
      (row) => row.template === definition.id && (!row.is_demo || c.MODEL_PROVIDER === 'demo'),
    )
    const issues = [...blockers]
    if (!product) issues.push('Услуга ещё не подготовлена в студии.')
    return {
      template: definition.id,
      name: definition.label,
      description: definition.delivery,
      inputLabel: definition.inputLabel,
      example: definition.example,
      productId: product?.id ?? null,
      version: product?.version ?? null,
      priceKopecks: product?.price_kopecks ?? null,
      currency: 'RUB' as const,
      testOnly: true as const,
      ready: issues.length === 0,
      blockers: issues,
    }
  })
  return {
    paymentMode: c.PAYMENT_MODE,
    modelMode: c.MODEL_PROVIDER === 'demo' ? 'demo' : 'configured',
    acceptingJobs: services.some((service) => service.ready),
    blockers,
    apiAccess: 'owner-session',
    x402: {
      status: 'not-implemented',
      reason:
        'Для x402 нужны отдельный платёжный адаптер, проверка и расчёт через facilitator. Текущая тестовая оплата не является x402.',
    },
    storefront: {
      url: '/storefront',
      published: products.filter(
        (product) =>
          product.visibility === 'public' && (!product.is_demo || c.MODEL_PROVIDER === 'demo'),
      ).length,
      testOnly: true,
    },
    services,
  }
}

/** A short-lived offer binds the full input, product snapshot, exact price and payment mode. */
export async function quoteService(
  productId: string,
  input: string,
  now = new Date(),
): Promise<ServiceQuoteView> {
  validateInput(input)
  return transaction(async (db) => {
    const [state] = await query('SELECT * FROM system_state WHERE id=true FOR UPDATE', [], db)
    await assertAdmission(state, db, now.getTime())
    const product = await offeredProduct(productId, db)
    checkProductInput(product, input)
    const paymentMode = config().PAYMENT_MODE
    const expiresAt = now.getTime() + serviceQuoteTtlMs
    const quote = signServiceQuote(
      {
        v: 1,
        id: randomUUID(),
        productId,
        version: product.version,
        priceKopecks: product.price_kopecks,
        productDigest: productDigest(product),
        inputDigest: digest(input),
        paymentMode,
        issuedAt: now.getTime(),
        expiresAt,
      },
      config().SESSION_SECRET,
    )
    return {
      quote,
      expiresAt: new Date(expiresAt).toISOString(),
      productId,
      version: product.version,
      name: serviceByTemplate[product.template as ServiceTemplate].label,
      priceKopecks: product.price_kopecks,
      currency: 'RUB',
      paymentMode,
      testOnly: true,
    }
  })
}

/** No payment and no execution here: the normal explicit test payment opens the fulfill job. */
export async function createServiceJob(
  request: { quote: string; input: string; requestKey: string },
  now = new Date(),
): Promise<ServiceJobView & { existing: boolean }> {
  validateInput(request.input)
  const quote = readServiceQuote(request.quote, config().SESSION_SECRET)
  const inputDigest = digest(request.input)
  if (quote.inputDigest !== inputDigest) throw new Error('SERVICE_QUOTE_INPUT_CHANGED')
  const key = requestKeyHash(request.requestKey)
  const quoteDigest = digest(request.quote)
  const created = await transaction(async (db) => {
    const [state] = await query('SELECT * FROM system_state WHERE id=true FOR UPDATE', [], db)
    const [existing] = await query('SELECT * FROM service_requests WHERE request_key=$1', [key], db)
    if (existing) {
      if (existing.quote_digest !== quoteDigest || existing.input_digest !== inputDigest)
        throw new Error('IDEMPOTENCY_CONFLICT')
      return { id: existing.id as string, existing: true }
    }
    if ((await query('SELECT id FROM service_requests WHERE quote_id=$1', [quote.id], db)).length)
      throw new Error('SERVICE_QUOTE_ALREADY_USED')
    // Other order APIs share the idempotency namespace; never adopt their order as this job.
    if ((await query('SELECT id FROM orders WHERE request_key=$1', [key], db)).length)
      throw new Error('IDEMPOTENCY_CONFLICT')
    assertFreshServiceQuote(quote, now.getTime())
    if (quote.paymentMode !== config().PAYMENT_MODE) throw new Error('PAYMENT_MODE_MISMATCH')
    await assertAdmission(state, db, now.getTime())
    const product = await offeredProduct(quote.productId, db)
    if (productDigest(product) !== quote.productDigest) throw new Error('SERVICE_QUOTE_CHANGED')
    checkProductInput(product, request.input)
    const orderId = await insertOrder(db, {
      product,
      state: state!,
      input: request.input,
      requestKey: request.requestKey,
      priceKopecks: quote.priceKopecks,
      amountWei: (sequence) =>
        invoiceWei(
          quote.priceKopecks,
          config().TEST_ETH_RUB_RATE,
          invoiceUnique(sequence),
        ).toString(),
    })
    const id = randomUUID()
    await query(
      `INSERT INTO service_requests(id,quote_id,request_key,quote_digest,input_digest,order_id)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [id, quote.id, key, quoteDigest, inputDigest, orderId],
      db,
    )
    await audit(
      'service_job_created',
      'Создан заказ через API услуг. Ожидается отдельная тестовая оплата.',
      { serviceJobId: id, orderId, productId: product.id, version: product.version },
      db,
    )
    return { id, existing: false }
  })
  return { ...(await serviceJob(created.id)), existing: created.existing }
}

export async function serviceJob(id: string): Promise<ServiceJobView> {
  const [row] = await query(
    `SELECT s.id,o.id AS order_id,o.number,o.status,o.payment_mode,o.result,o.created_at,o.delivered_at
     FROM service_requests s JOIN orders o ON o.id=s.order_id WHERE s.id=$1`,
    [id],
  )
  if (!row) throw new Error('SERVICE_JOB_NOT_FOUND')
  return {
    id: row.id,
    orderId: row.order_id,
    number: Number(row.number),
    status: row.status,
    orderUrl: `/office/orders/${row.order_id}`,
    paymentMode: row.payment_mode,
    testOnly: true,
    result: row.status === 'delivered' ? row.result : null,
    createdAt: new Date(row.created_at).toISOString(),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
  }
}
