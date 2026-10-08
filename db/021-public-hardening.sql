-- Public site hardening after the security review. Additive and safe to re-run.

-- Idempotency keys are stored as 'sha256:<hex>': a public order's link is derived from its key
-- with the server secret, so the key itself must not sit in the database. Existing keys are
-- hashed in place; the same request keeps finding its order.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'orders'
        AND column_name = 'request_key') = 'uuid' THEN
    ALTER TABLE orders ALTER COLUMN request_key TYPE text
      USING 'sha256:' || encode(sha256(convert_to(request_key::text, 'UTF8')), 'hex');
  END IF;
END $$;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_request_key_hashed;
ALTER TABLE orders ADD CONSTRAINT orders_request_key_hashed
  CHECK (request_key ~ '^sha256:[0-9a-f]{64}$');

-- The node has shown this transaction (mined, or rejected for its content). A hash the node has
-- never shown is not kept open for a day after the invoice ends.
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS seen_at timestamptz;
UPDATE payment_attempts SET seen_at = COALESCE(checked_at, submitted_at)
WHERE seen_at IS NULL AND (proof IS NOT NULL OR detected_by_scan);

-- Open unpaid public orders per buyer address.
CREATE INDEX IF NOT EXISTS orders_public_client_open ON orders(client_key)
  WHERE source = 'public' AND status = 'awaiting_payment';

-- Unpaid public orders no longer hold model budget: it is reserved at payment. Release what
-- older unpaid public orders still hold; untouched reservations go back to zero.
UPDATE budget_reservations r SET limit_kopecks = 0
FROM orders o
WHERE o.reservation_id = r.id AND o.source = 'public' AND o.status = 'awaiting_payment'
  AND o.paid_at IS NULL AND r.status = 'open' AND r.spent_kopecks = 0;
