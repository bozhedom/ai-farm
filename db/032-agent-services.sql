-- Owner-only service API. A quote creates at most one ordinary test order.
-- No new payment rail: existing budget, fulfillment and quality gates remain in charge.
CREATE TABLE IF NOT EXISTS service_requests (
  id uuid PRIMARY KEY,
  quote_id uuid NOT NULL UNIQUE,
  request_key text NOT NULL UNIQUE CHECK (request_key ~ '^sha256:[0-9a-f]{64}$'),
  quote_digest text NOT NULL CHECK (quote_digest ~ '^[0-9a-f]{64}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
