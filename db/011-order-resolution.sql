ALTER TABLE orders ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS resolution_reason text;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('awaiting_payment','paid','running','delivered','expired','manual_review','closed'));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_resolution_check;
ALTER TABLE orders ADD CONSTRAINT orders_resolution_check CHECK (
  (status = 'closed' AND closed_at IS NOT NULL AND resolution_reason IS NOT NULL)
  OR (status <> 'closed' AND closed_at IS NULL AND resolution_reason IS NULL)
);
