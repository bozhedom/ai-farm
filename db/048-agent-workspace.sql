CREATE TABLE agent_profiles (
  role text PRIMARY KEY,
  instruction text NOT NULL DEFAULT '' CHECK (length(instruction) <= 6000),
  model text NOT NULL DEFAULT '' CHECK (length(model) <= 160),
  pricing jsonb,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_context (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 12000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_context_role ON agent_context(role);
ALTER TABLE system_state ADD COLUMN idea_daily_limit integer NOT NULL DEFAULT 24 CHECK (idea_daily_limit BETWEEN 0 AND 24);
ALTER TABLE system_state ADD COLUMN idea_products_per_day integer CHECK (idea_products_per_day BETWEEN 0 AND 12);
ALTER TABLE system_state ADD COLUMN owner_daily_budget_kopecks integer CHECK (owner_daily_budget_kopecks >= 0);
ALTER TABLE system_state ADD COLUMN owner_monthly_budget_kopecks integer CHECK (owner_monthly_budget_kopecks >= 0);
ALTER TABLE system_state DROP CONSTRAINT system_state_schedule_hour;
ALTER TABLE system_state ADD CONSTRAINT system_state_schedule_hour CHECK (schedule_hour_utc BETWEEN 0 AND 23);
