import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { qualityCases } from './fixtures/quality'

// Override before importing core/db: a local acceptance run can never reach a paid adapter.
const database = process.env.QUALITY_DATABASE_URL
if (!database || !new URL(database).pathname.endsWith('_test'))
  throw new Error('QUALITY_DATABASE_MUST_END_IN_TEST')
const provider = process.env.QUALITY_PROVIDER || 'ollama'
if (!['ollama', 'openrouter'].includes(provider)) throw new Error('FREE_QUALITY_PROVIDER_REQUIRED')
if (provider === 'ollama') {
  const endpoint = new URL(process.env.OLLAMA_URL || 'http://127.0.0.1:11434')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
    throw new Error('LOCAL_OLLAMA_REQUIRED')
}
Object.assign(process.env, {
  DATABASE_URL: database,
  MODEL_PROVIDER: provider,
  SEARCH_PROVIDER: 'searxng',
  AUTONOMY_ENABLED: 'false',
})
const { pool, query } = await import('../core/db')
const { model } = await import('../core/providers')
const { reserveBudget, closeReservation } = await import('../core/budget')
const { reviewSchema, validateTemplateInput, validateOutput } = await import('../core/policy')
const { reviewContext } = await import('../core/jobs/text-context')
const { recipes } = await import('../core/templates')
const { generateText } = await import('../core/jobs/generate-text')
const { sourceSocialDelivery } = await import('../core/source-posts')
const { config } = await import('../core/config')

const cases = process.env.QUALITY_TEMPLATE
  ? qualityCases.filter((item) => item.template === process.env.QUALITY_TEMPLATE)
  : qualityCases
if (!cases.length) throw new Error('QUALITY_TEMPLATE_UNSUPPORTED')
const run = randomUUID()
const results: Record<string, unknown>[] = []
try {
  const [db] = await query('SELECT current_database() AS name')
  if (!db?.name.endsWith('_test')) throw new Error('REFUSING_NON_TEST_DATABASE')
  for (const name of readdirSync('db')
    .filter((name) => name.endsWith('.sql'))
    .sort())
    await query(readFileSync(`db/${name}`, 'utf8'))
  for (const item of cases) {
    const key = `quality:${run}:${item.template}`
    const reservationId = await reserveBudget(key, 'order')
    const product = {
      template: item.template,
      promise: item.template === 'social' ? sourceSocialDelivery : recipes[item.template].delivery,
    }
    let output: string | undefined
    try {
      validateTemplateInput(item.template, item.input)
      const generated = await generateText({
        key: `${key}:generate`,
        reservationId,
        product,
        input: item.input,
        approach: 'Короткие формулировки, только исходные факты.',
      })
      output = generated.text
      validateOutput(item.template, output)
      const review = await model({
        role: 'Проверяющий',
        key: `${key}:review`,
        reservationId,
        context: reviewContext(product, item.input, output),
        schema: reviewSchema,
        demoValue: { verdict: 'BLOCKED', reason: 'Демопровайдер запрещён.' },
      })
      results.push({ ...item, output, review })
      console.log(`${item.template}: ${review.verdict}`)
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : 'QUALITY_CHECK_FAILED'
      results.push({ ...item, output, error: code })
      console.log(`${item.template}: ${code}`)
    } finally {
      await closeReservation(reservationId)
    }
  }
  const usage = await query(
    'SELECT role,model,status,input_tokens,output_tokens,charged_kopecks,actual_microusd,charged_microusd FROM tool_calls WHERE call_key LIKE $1 ORDER BY created_at',
    [`quality:${run}:%`],
  )
  mkdirSync('output/quality', { recursive: true })
  const path = `output/quality/${run}.json`
  writeFileSync(
    path,
    JSON.stringify(
      {
        run,
        checkedAt: new Date().toISOString(),
        model: provider === 'openrouter' ? config().OPENROUTER_MODEL : config().OLLAMA_MODEL,
        note: `${cases.length} контрольных примеров. PASS модели требует чтения человеком и не доказывает общее качество.`,
        results,
        usage,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  console.log(`Report: ${path}`)
  if (results.some((r) => r.error || (r.review as { verdict: string }).verdict !== 'PASS'))
    process.exitCode = 1
} finally {
  await pool.end()
}
