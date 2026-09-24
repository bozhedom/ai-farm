import { defineEventHandler } from 'h3'
import { config } from '../../core/config'
import { query } from '../../core/db'
import { budgetSummary } from '../../core/budget'
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
      'SELECT id,kind,status,attempts,error_code,created_at FROM jobs ORDER BY created_at DESC LIMIT 20',
    ),
    query('SELECT * FROM audit_events ORDER BY id DESC LIMIT 50'),
    query('SELECT * FROM evaluations ORDER BY created_at DESC LIMIT 10'),
    budgetSummary(),
    query(
      'SELECT role,status,charged_kopecks,is_demo,created_at FROM tool_calls ORDER BY created_at DESC LIMIT 30',
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
    toolCalls,
    config: {
      modelProvider: c.MODEL_PROVIDER,
      searchProvider: c.SEARCH_PROVIDER,
      paymentMode: c.PAYMENT_MODE,
      monthlyLimit: c.MONTHLY_BUDGET_KOPECKS,
      dailyLimit: c.DAILY_BUDGET_KOPECKS,
      autonomyEnabled: c.AUTONOMY_ENABLED,
    },
    realRevenueKopecks: 0,
  }
})
