ALTER TABLE budget_reservations DROP CONSTRAINT budget_reservations_category_check;
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_category_check
  CHECK (category IN ('research','order','scout','lead','report','trading_manager'));
ALTER TABLE trading_portfolios ADD COLUMN manager_revision integer NOT NULL DEFAULT 0;

CREATE TABLE trading_manager (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  enabled boolean NOT NULL DEFAULT false,
  requested_at timestamptz,
  attempted_at timestamptz,
  tasks_checked_at timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  last_error text NOT NULL DEFAULT '',
  CHECK ((lease_id IS NULL) = (lease_until IS NULL))
);
INSERT INTO trading_manager(id) VALUES(true);

CREATE TABLE trading_manager_runs (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK(status IN ('running','completed','failed','discarded')),
  reservation_id uuid REFERENCES budget_reservations(id),
  provider text NOT NULL,
  model text NOT NULL,
  is_demo boolean NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}',
  plan jsonb,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX trading_manager_one_run ON trading_manager_runs((true)) WHERE status='running';

CREATE TABLE trading_manager_tasks (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES trading_manager_runs(id),
  exchange text NOT NULL,
  mode text NOT NULL DEFAULT 'paper' CHECK(mode='paper'),
  source_agent_id uuid NOT NULL,
  agent_id uuid,
  source jsonb NOT NULL,
  proposal jsonb NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','observing','completed','rejected','expired')),
  reason text NOT NULL DEFAULT '',
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  evaluate_at timestamptz,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY(exchange,mode) REFERENCES trading_portfolios(exchange,mode),
  FOREIGN KEY(source_agent_id,exchange,mode) REFERENCES trading_agents(id,exchange,mode),
  FOREIGN KEY(agent_id,exchange,mode) REFERENCES trading_agents(id,exchange,mode),
  UNIQUE(run_id,exchange),
  UNIQUE(agent_id),
  CHECK ((status='observing') IS NOT TRUE OR (agent_id IS NOT NULL AND applied_at IS NOT NULL AND evaluate_at IS NOT NULL))
);
CREATE UNIQUE INDEX trading_manager_one_experiment ON trading_manager_tasks(exchange)
  WHERE status IN ('queued','observing');
CREATE INDEX trading_manager_task_history ON trading_manager_tasks(created_at DESC);
