-- Agents get server-owned parameters and a real quality selection. History is never deleted.
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}';   -- strategyParamsSchema
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS mutation jsonb;                       -- {param, from, to}
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS retired_reason text;
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS retired_round_id uuid;
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS born_round_id uuid;

CREATE TABLE IF NOT EXISTS evolution_rounds (
  id uuid PRIMARY KEY,
  round_key text UNIQUE NOT NULL,            -- 'evolution:<generation>' for ROTATED, 'evolution-check:<id>' for HOLD
  generation integer NOT NULL,
  decision text NOT NULL CHECK (decision IN ('HOLD','ROTATED')),
  reason text NOT NULL,
  scores jsonb NOT NULL,                     -- [{strategyId, score, components, samples}]
  archived uuid[] NOT NULL DEFAULT '{}',
  children jsonb NOT NULL DEFAULT '[]',      -- [{id, parentId, mutation}]
  trigger text NOT NULL CHECK (trigger IN ('threshold','schedule','owner')),
  is_demo boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One rotation per generation, even when two workers race.
CREATE UNIQUE INDEX IF NOT EXISTS evolution_rotated_once_per_generation
  ON evolution_rounds(generation) WHERE decision = 'ROTATED';
CREATE INDEX IF NOT EXISTS evolution_rounds_recent ON evolution_rounds(created_at DESC);
ALTER TABLE strategies DROP CONSTRAINT IF EXISTS strategies_retired_round_fk;
ALTER TABLE strategies ADD CONSTRAINT strategies_retired_round_fk
  FOREIGN KEY (retired_round_id) REFERENCES evolution_rounds(id);
ALTER TABLE strategies DROP CONSTRAINT IF EXISTS strategies_born_round_fk;
ALTER TABLE strategies ADD CONSTRAINT strategies_born_round_fk
  FOREIGN KEY (born_round_id) REFERENCES evolution_rounds(id);

ALTER TABLE system_state ADD COLUMN IF NOT EXISTS evolution_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE system_state ADD COLUMN IF NOT EXISTS evolution_min_ideas integer NOT NULL DEFAULT 6
  CHECK (evolution_min_ideas BETWEEN 1 AND 100);
ALTER TABLE system_state ADD COLUMN IF NOT EXISTS evolution_rounds_per_day integer NOT NULL DEFAULT 1
  CHECK (evolution_rounds_per_day BETWEEN 0 AND 24);
ALTER TABLE system_state ADD COLUMN IF NOT EXISTS scouts_per_strategy_per_day integer NOT NULL DEFAULT 1
  CHECK (scouts_per_strategy_per_day BETWEEN 0 AND 6);
ALTER TABLE system_state ADD COLUMN IF NOT EXISTS leads_per_day integer NOT NULL DEFAULT 4
  CHECK (leads_per_day BETWEEN 0 AND 12);
UPDATE system_state SET policy_version = 'v3' WHERE id = true;
ALTER TABLE system_state ALTER COLUMN policy_version SET DEFAULT 'v3';
