import { defineEventHandler } from 'h3'
import { config, usesSourcePosts } from '../../core/config'
import { query } from '../../core/db'
import { budgetSummary } from '../../core/budget'
import { resultSummary } from '../../core/activity'
import { recipes } from '../../core/templates'
import { sourceSocialDelivery, sourceSocialInputLimit } from '../../core/source-posts'
import { templateSchema } from '../../core/policy'
import { autonomyStatus, type AutonomyState } from '../../core/autonomy'
export default defineEventHandler(async () => {
  const [
    state,
    strategies,
    hypotheses,
    products,
    orders,
    jobs,
    audit,
    evaluations,
    budget,
    toolCalls,
    workload,
    orderStats,
  ] = await Promise.all([
    query<AutonomyState>('SELECT * FROM system_state WHERE id=true'),
    query(`SELECT s.*,count(o.id) FILTER(WHERE o.status='delivered')::int AS test_delivered FROM strategies s
      LEFT JOIN orders o ON o.strategy_id=s.id GROUP BY s.id ORDER BY s.status,s.created_at,s.id`),
    query(`SELECT h.*,v.version AS released_version,v.product_id AS released_product_id,
      (SELECT t.model FROM tool_calls t WHERE t.job_id=h.job_id AND t.template=h.template
       AND t.role='Исследователь' LIMIT 1) AS generated_by_model
      FROM hypotheses h LEFT JOIN LATERAL (
        SELECT version,product_id FROM product_versions WHERE hypothesis_id=h.id ORDER BY version DESC LIMIT 1
      ) v ON true ORDER BY h.created_at DESC LIMIT 30`),
    query('SELECT * FROM products ORDER BY created_at'),
    query(
      `SELECT id,status,payment_mode,amount_wei,created_at,product_snapshot,strategy_snapshot FROM orders ORDER BY CASE WHEN status='manual_review' THEN 0 WHEN status IN ('paid','running') THEN 1 WHEN status='awaiting_payment' THEN 2 ELSE 3 END,created_at DESC LIMIT 30`,
    ),
    query(
      "SELECT id,kind,status,attempts,error_code,created_at,started_at,finished_at,locked_until,payload FROM jobs ORDER BY (status='running') DESC,created_at DESC LIMIT 20",
    ),
    query('SELECT * FROM audit_events ORDER BY id DESC LIMIT 50'),
    query('SELECT * FROM evaluations ORDER BY created_at DESC LIMIT 10'),
    budgetSummary(),
    query(
      `SELECT id,job_id,template,task_label,provider,model,role,status,charged_kopecks,is_demo,
       created_at,finished_at,heartbeat_at,progress_chars,input_tokens,output_tokens,error_code,output,
       cached_tokens,cache_write_tokens,reasoning_tokens,actual_microusd,charged_microusd
      FROM tool_calls ORDER BY created_at DESC LIMIT 120`,
    ),
    query(
      `SELECT count(*) FILTER(WHERE status='running')::int AS running,
        count(*) FILTER(WHERE status='queued')::int AS queued,
        count(*) FILTER(WHERE dedupe_key LIKE 'manual-research:%' AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS manual_research_today
       FROM jobs`,
    ),
    query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE status='delivered')::int AS delivered
      FROM orders`),
  ])
  const c = config()
  const autonomy = await autonomyStatus(state[0]!, budget)
  return {
    state: state[0],
    strategies,
    hypotheses,
    products: products.map((product) => ({
      ...product,
      delivery:
        product.template === 'social' && product.spec.promise === sourceSocialDelivery
          ? sourceSocialDelivery
          : recipes[templateSchema.parse(product.template)].delivery,
      inputLimit:
        product.template === 'social' && product.spec.promise === sourceSocialDelivery
          ? sourceSocialInputLimit
          : 4000,
      needsRefresh:
        product.template === 'social' &&
        usesSourcePosts(c.MODEL_PROVIDER) &&
        product.spec.promise !== sourceSocialDelivery,
    })),
    orders,
    orderStats: orderStats[0],
    jobs,
    audit,
    evaluations,
    budget,
    autonomy,
    workload: workload[0],
    toolCalls: toolCalls.map(({ output, ...call }) => ({
      ...call,
      resultSummary: resultSummary(output),
      sources:
        call.role === 'search' && Array.isArray(output)
          ? output.map(({ url, title }) => ({ url, title }))
          : [],
      idea:
        call.role === 'Исследователь' && call.status === 'done' && output
          ? {
              title: output.title,
              hypothesis: output.hypothesis,
              counterargument: output.counterargument,
              experiment: output.experiment,
            }
          : null,
    })),
    serverTime: new Date().toISOString(),
    nextResearchAt: autonomy.nextAt,
    config: {
      modelProvider: c.MODEL_PROVIDER,
      model:
        c.MODEL_PROVIDER === 'ollama'
          ? c.OLLAMA_MODEL
          : c.MODEL_PROVIDER === 'openai'
            ? c.OPENAI_MODEL
            : c.MODEL_PROVIDER === 'openrouter'
              ? c.OPENROUTER_MODEL
              : c.MODEL_PROVIDER === 'yandex'
                ? c.YANDEX_MODEL
                : 'Шаблонный демопровайдер',
      searchProvider: c.SEARCH_PROVIDER,
      paymentMode: c.PAYMENT_MODE,
      monthlyLimit: c.MONTHLY_BUDGET_KOPECKS,
      dailyLimit: c.DAILY_BUDGET_KOPECKS,
      autonomyEnabled: autonomy.enabled,
      openaiTotalLimitMicrousd: c.OPENAI_TOTAL_BUDGET_MICROUSD,
      openrouterFreeOnly: true,
      openrouterTotalLimitMicrousd: 0,
    },
    realRevenueKopecks: 0,
  }
})
