import { defineEventHandler } from 'h3'
import { config } from '../../core/config'
import { query } from '../../core/db'
import { budgetSummary } from '../../core/budget'
import { resultSummary } from '../../core/activity'
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
  ] = await Promise.all([
    query('SELECT * FROM system_state WHERE id=true'),
    query(`SELECT s.*,count(o.id) FILTER(WHERE o.status='delivered')::int AS test_delivered FROM strategies s
      LEFT JOIN orders o ON o.strategy_id=s.id GROUP BY s.id ORDER BY s.status,s.created_at,s.id`),
    query('SELECT * FROM hypotheses ORDER BY created_at DESC LIMIT 30'),
    query('SELECT * FROM products ORDER BY created_at'),
    query(
      'SELECT id,status,payment_mode,amount_wei,created_at,product_snapshot,strategy_snapshot FROM orders ORDER BY created_at DESC LIMIT 30',
    ),
    query(
      "SELECT id,kind,status,attempts,error_code,created_at,started_at,finished_at,locked_until,payload FROM jobs ORDER BY (status='running') DESC,created_at DESC LIMIT 20",
    ),
    query('SELECT * FROM audit_events ORDER BY id DESC LIMIT 50'),
    query('SELECT * FROM evaluations ORDER BY created_at DESC LIMIT 10'),
    budgetSummary(),
    query(
      `SELECT id,job_id,template,task_label,provider,model,role,status,charged_kopecks,is_demo,
       created_at,finished_at,heartbeat_at,progress_chars,error_code,output
      FROM tool_calls ORDER BY created_at DESC LIMIT 120`,
    ),
    query(
      "SELECT count(*) FILTER(WHERE status='running')::int AS running,count(*) FILTER(WHERE status='queued')::int AS queued FROM jobs",
    ),
  ])
  const c = config()
  return {
    state: state[0],
    strategies,
    hypotheses,
    products,
    orders,
    jobs,
    audit,
    evaluations,
    budget,
    workload: workload[0],
    toolCalls: toolCalls.map(({ output, ...call }) => ({
      ...call,
      resultSummary: resultSummary(output),
    })),
    serverTime: new Date().toISOString(),
    nextResearchAt: new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1),
    ).toISOString(),
    config: {
      modelProvider: c.MODEL_PROVIDER,
      model:
        c.MODEL_PROVIDER === 'ollama'
          ? c.OLLAMA_MODEL
          : c.MODEL_PROVIDER === 'yandex'
            ? c.YANDEX_MODEL
            : 'Шаблонный демопровайдер',
      searchProvider: c.SEARCH_PROVIDER,
      paymentMode: c.PAYMENT_MODE,
      monthlyLimit: c.MONTHLY_BUDGET_KOPECKS,
      dailyLimit: c.DAILY_BUDGET_KOPECKS,
      autonomyEnabled: c.AUTONOMY_ENABLED,
    },
    realRevenueKopecks: 0,
  }
})
