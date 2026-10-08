-- Public buyer orders, request limits and automatic detection of Sepolia transfers.
-- Additive only; safe to re-run. Payments stay test-only: is_test_payment remains true.

-- Secret order link: only sha256(token) is stored, never the token itself.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS access_token_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS orders_access_token_hash ON orders(access_token_hash)
  WHERE access_token_hash IS NOT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS token_rotated_at timestamptz;
-- HMAC(SESSION_SECRET, ip): groups abuse without storing the address.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_key text;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_public_link;
ALTER TABLE orders ADD CONSTRAINT orders_public_link
  CHECK (source <> 'public' OR (access_token_hash ~ '^[0-9a-f]{64}$' AND price_kopecks > 0));
CREATE INDEX IF NOT EXISTS orders_public_day ON orders(source, created_at);
CREATE INDEX IF NOT EXISTS orders_open_sepolia ON orders(created_at)
  WHERE payment_mode = 'sepolia' AND status = 'awaiting_payment';

-- Fixed-window request counters. key = HMAC(SESSION_SECRET, route:ip).
CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_start timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits(window_start);

-- A transfer found by the block scanner, not submitted by the buyer.
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS detected_by_scan boolean NOT NULL DEFAULT false;

-- Last scanned block per chain. The lease keeps two workers from scanning the same range.
CREATE TABLE IF NOT EXISTS payment_scan_state (
  chain_id integer PRIMARY KEY CHECK (chain_id = 11155111),
  last_block numeric(78,0) CHECK (last_block >= 0),
  lease_token uuid,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
