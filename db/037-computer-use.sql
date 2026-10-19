-- Computer use: GPT-6 Astra drives a browser on a separate VM through validated tool calls.
-- Tasks, steps, approvals and found opportunities are durable records; model costs go through
-- the shared tool_calls ledger under the new budget category. Screenshots live on disk
-- (COMPUTER_USE_SCREENSHOT_DIR); the step row keeps the path and size only. Additive only.
ALTER TABLE budget_reservations DROP CONSTRAINT IF EXISTS budget_reservations_category_check;
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_category_check
  CHECK (category IN ('research','order','scout','lead','report','trading_manager','computer_use'));

CREATE TABLE IF NOT EXISTS computer_use (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  rotation_index integer NOT NULL DEFAULT 0 CHECK (rotation_index >= 0),
  -- Consecutive failed tasks; the owner's enable resets it.
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  lease_id uuid,
  lease_until timestamptz,
  last_error text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL))
);
INSERT INTO computer_use(id) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS computer_use_tasks (
  id uuid PRIMARY KEY,
  goal text NOT NULL CHECK (length(goal) BETWEEN 10 AND 1000),
  source text NOT NULL CHECK (source IN ('owner','rotation')),
  status text NOT NULL CHECK (status IN ('queued','running','waiting_approval','done','failed','cancelled')),
  step_count integer NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  step_limit integer NOT NULL CHECK (step_limit BETWEEN 1 AND 200),
  cost_cap_microusd integer NOT NULL CHECK (cost_cap_microusd >= 0),
  reservation_id uuid REFERENCES budget_reservations(id),
  provider text NOT NULL,
  model text NOT NULL,
  is_demo boolean NOT NULL,
  session_id text,
  report text NOT NULL DEFAULT '' CHECK (length(report) <= 4000),
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CHECK ((status IN ('done','failed','cancelled')) = (finished_at IS NOT NULL))
);
-- One task at a time: the worker never drives two browser sessions.
CREATE UNIQUE INDEX IF NOT EXISTS computer_use_one_active ON computer_use_tasks((true))
  WHERE status IN ('running','waiting_approval');
CREATE INDEX IF NOT EXISTS computer_use_tasks_history ON computer_use_tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS computer_use_tasks_queue ON computer_use_tasks(created_at)
  WHERE status='queued';

CREATE TABLE IF NOT EXISTS computer_use_steps (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES computer_use_tasks(id),
  step_no integer NOT NULL CHECK (step_no >= 1),
  action jsonb NOT NULL,                      -- validated tool call {name, args}
  decision text NOT NULL CHECK (decision IN ('allowed','approval','approved','rejected','blocked','invalid','failed')),
  reason text NOT NULL DEFAULT '',
  reasoning text NOT NULL DEFAULT '' CHECK (length(reasoning) <= 2000),
  url_before text NOT NULL DEFAULT '',
  url_after text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  screenshot_path text,
  screenshot_bytes integer NOT NULL DEFAULT 0 CHECK (screenshot_bytes >= 0),
  call_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, step_no)
);

CREATE TABLE IF NOT EXISTS computer_use_approvals (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES computer_use_tasks(id),
  step_no integer NOT NULL,
  action jsonb NOT NULL,
  reason text NOT NULL CHECK (length(reason) <= 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  -- The worker records the decision as a step exactly once.
  executed_at timestamptz,
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK (executed_at IS NULL OR resolved_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS computer_use_one_pending_approval ON computer_use_approvals(task_id)
  WHERE status='pending';

-- Findings are records for the owner, never revenue or an obligation.
CREATE TABLE IF NOT EXISTS computer_use_opportunities (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES computer_use_tasks(id),
  step_no integer NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 4 AND 160),
  url text NOT NULL CHECK (length(url) <= 2000),
  summary text NOT NULL CHECK (length(summary) <= 1500),
  kind text NOT NULL CHECK (kind IN ('bounty','freelance','grant','airdrop','digital_product','service_demand','other')),
  requires_human boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','saved','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, url)
);
CREATE INDEX IF NOT EXISTS computer_use_opportunities_recent ON computer_use_opportunities(created_at DESC);
