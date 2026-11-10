-- Owner-authorized bounded Bybit strategy review. No balance, stop or model changes.
CREATE TABLE trading_live_reviews (
  run_id uuid PRIMARY KEY REFERENCES trading_manager_runs(id),
  exchange text NOT NULL DEFAULT 'bybit' CHECK(exchange='bybit'),
  mode text NOT NULL DEFAULT 'live' CHECK(mode='live'),
  agent_id uuid NOT NULL,
  trigger_key text NOT NULL,
  source jsonb NOT NULL,
  proposal jsonb,
  review jsonb,
  analyst_model text NOT NULL DEFAULT '',
  instruction_revision integer NOT NULL,
  status text NOT NULL CHECK(status IN ('analyzing','queued','applied','completed','rejected','expired','failed')),
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  FOREIGN KEY(agent_id,exchange,mode) REFERENCES trading_agents(id,exchange,mode)
);
CREATE UNIQUE INDEX trading_live_review_pending ON trading_live_reviews((true)) WHERE status IN ('analyzing','queued');
CREATE INDEX trading_live_review_history ON trading_live_reviews(created_at DESC);
