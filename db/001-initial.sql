CREATE TABLE IF NOT EXISTS system_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  mode text NOT NULL DEFAULT 'running' CHECK (mode IN ('running','paused','emergency_stop')),
  generation integer NOT NULL DEFAULT 1,
  generation_started_at timestamptz NOT NULL DEFAULT now(),
  worker_heartbeat timestamptz,
  policy_version text NOT NULL DEFAULT 'v1'
);
INSERT INTO system_state(id) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS strategies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  approach text NOT NULL,
  parent_id uuid REFERENCES strategies(id),
  generation integer NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('research','fulfill','evaluate')),
  dedupe_key text UNIQUE NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  lease_token uuid,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS hypotheses (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  template text NOT NULL,
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','rejected','backlog')),
  evidence jsonb NOT NULL,
  research jsonb NOT NULL,
  critique jsonb NOT NULL,
  is_demo boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, template)
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  hypothesis_id uuid NOT NULL REFERENCES hypotheses(id),
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  template text NOT NULL UNIQUE,
  spec jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'sandbox' CHECK (status IN ('sandbox','archived')),
  is_demo boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS budget_reservations (
  id uuid PRIMARY KEY,
  dedupe_key text UNIQUE NOT NULL,
  category text NOT NULL CHECK(category IN ('research','order')),
  limit_kopecks integer NOT NULL CHECK (limit_kopecks >= 0),
  spent_kopecks integer NOT NULL DEFAULT 0 CHECK (spent_kopecks >= 0 AND spent_kopecks <= limit_kopecks),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id uuid PRIMARY KEY,
  call_key text UNIQUE NOT NULL,
  reservation_id uuid NOT NULL REFERENCES budget_reservations(id),
  role text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','done','uncertain')),
  reserved_kopecks integer NOT NULL CHECK(reserved_kopecks >= 0),
  charged_kopecks integer NOT NULL DEFAULT 0 CHECK(charged_kopecks >= 0),
  output jsonb,
  is_demo boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS invoice_amount_sequence START 1;
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  request_key uuid UNIQUE NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  product_snapshot jsonb NOT NULL,
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  strategy_snapshot jsonb NOT NULL,
  generation integer NOT NULL,
  input text NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_payment' CHECK(status IN ('awaiting_payment','paid','running','delivered','expired','manual_review')),
  payment_mode text NOT NULL CHECK(payment_mode IN ('sandbox','sepolia')),
  currency text NOT NULL DEFAULT 'TEST_ETH' CHECK(currency = 'TEST_ETH'),
  amount_wei numeric(78,0) UNIQUE NOT NULL,
  receiver text NOT NULL,
  tx_hash text UNIQUE,
  confirmations integer NOT NULL DEFAULT 0,
  reservation_id uuid NOT NULL REFERENCES budget_reservations(id),
  result text,
  review jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  paid_at timestamptz,
  delivered_at timestamptz,
  last_payment_check timestamptz,
  payment_error text
);

CREATE TABLE IF NOT EXISTS evaluations (
  id uuid PRIMARY KEY,
  evaluation_key text UNIQUE NOT NULL,
  generation integer NOT NULL,
  decision text NOT NULL CHECK (decision IN ('HOLD','SIMULATION','CLOSED')),
  reason text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  message text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_attempts (
  key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now()
);
