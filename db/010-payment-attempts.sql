ALTER TABLE orders ADD COLUMN IF NOT EXISTS required_confirmations integer NOT NULL DEFAULT 3 CHECK (required_confirmations BETWEEN 3 AND 64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_lease_token uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_locked_until timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_proof jsonb;
ALTER TABLE system_state ADD COLUMN IF NOT EXISTS payment_heartbeat timestamptz;

-- A submitted hash stays attached to its original invoice even after replacement.
CREATE TABLE IF NOT EXISTS payment_attempts (
  tx_hash text PRIMARY KEY CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  order_id uuid NOT NULL REFERENCES orders(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  confirmations integer NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
  error_code text,
  proof jsonb,
  confirmed_at timestamptz
);
CREATE INDEX IF NOT EXISTS payment_attempts_order ON payment_attempts(order_id,submitted_at);
INSERT INTO payment_attempts(tx_hash,order_id,submitted_at,checked_at,confirmations,error_code,confirmed_at)
SELECT lower(tx_hash),id,created_at,last_payment_check,confirmations,payment_error,paid_at
FROM orders WHERE payment_mode='sepolia' AND tx_hash ~* '^0x[0-9a-f]{64}$'
ON CONFLICT(tx_hash) DO NOTHING;
