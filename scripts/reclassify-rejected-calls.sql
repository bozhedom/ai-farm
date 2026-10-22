-- Reclassifies paid calls that OpenRouter rejected before generation (HTTP 400/401/403/404/422)
-- and that never recorded usage. Before migration 045 such calls stayed `uncertain` with the full
-- pessimistic charge. Nothing was billed for them: the charge is released and the call becomes
-- `rejected`, exactly as core/budget.ts now does at the moment of failure.
--
-- Idempotent: only `uncertain` rows match, so a second run changes nothing. Ambiguous outcomes
-- (408, 429, 5xx, timeouts, network errors, any recorded usage or response id) are never touched.
-- Requires migration 045 (status `rejected`). The operator runs it by hand after reviewing the
-- preview below; the farm never runs it automatically.
--
--   bash deploy/timeweb/dc.sh exec -T db sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' \
--     < scripts/reclassify-rejected-calls.sql
BEGIN;
-- Same lock as every budget admission (core/budget.ts).
SELECT pg_advisory_xact_lock(735093);

SELECT id, call_key, role, error_code, charged_kopecks, charged_microusd, created_at
FROM tool_calls
WHERE status = 'uncertain'
  AND provider IN ('openai', 'openrouter')
  AND error_code ~ '^OPENROUTER_HTTP_(400|401|403|404|422)$'
  AND actual_microusd IS NULL AND input_tokens IS NULL AND output_tokens IS NULL
  AND provider_response_id IS NULL
ORDER BY created_at;

WITH rejected AS (
  UPDATE tool_calls SET status = 'rejected', charged_kopecks = 0, charged_microusd = 0
  WHERE status = 'uncertain'
    AND provider IN ('openai', 'openrouter')
    AND error_code ~ '^OPENROUTER_HTTP_(400|401|403|404|422)$'
    AND actual_microusd IS NULL AND input_tokens IS NULL AND output_tokens IS NULL
    AND provider_response_id IS NULL
  RETURNING id, reservation_id, role, error_code, reserved_kopecks
), released AS (
  UPDATE budget_reservations r
  SET spent_kopecks = GREATEST(r.spent_kopecks - x.amount, 0)
  FROM (SELECT reservation_id, sum(reserved_kopecks)::int AS amount FROM rejected
        GROUP BY reservation_id) x
  WHERE r.id = x.reservation_id
  RETURNING r.id
)
INSERT INTO audit_events(kind, message, data)
SELECT 'tool_rejected',
  'Провайдер отклонил запрос до генерации. Деньги не списаны, резерв освобождён (переклассификация).',
  jsonb_build_object('role', role, 'callId', id, 'errorCode', error_code, 'reclassified', true)
FROM rejected;

COMMIT;
