-- Search directions for computer use (owner request of 21.10.2026): the farm looks for income in
-- any legal direction and the owner steers the rotation. Built-in directions are seeded by the
-- server from core/computer-use/goals.ts (ON CONFLICT (key) DO NOTHING, so owner edits stay);
-- the owner adds, edits, enables and disables directions in the office. Goal texts pass the
-- same forbidden-scheme checks as owner goals before they reach this table. Additive only.
CREATE TABLE IF NOT EXISTS computer_use_directions (
  id uuid PRIMARY KEY,
  -- Stable name of a built-in direction; NULL for the owner's own directions.
  key text UNIQUE CHECK (key IS NULL OR key ~ '^[a-z][a-z0-9_-]{1,60}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 80),
  goal text NOT NULL CHECK (length(goal) BETWEEN 10 AND 1000),
  enabled boolean NOT NULL DEFAULT true,
  -- Owner priority 1..5; the rotation multiplies it by the observed yield (bounded).
  weight integer NOT NULL DEFAULT 3 CHECK (weight BETWEEN 1 AND 5),
  built_in boolean NOT NULL DEFAULT false,
  -- Display order: built-ins in seed order, owner directions after them.
  position integer NOT NULL DEFAULT 1000 CHECK (position >= 0),
  -- Smooth weighted round-robin balance; bounded by the sum of effective weights.
  credit integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  tasks integer NOT NULL DEFAULT 0 CHECK (tasks >= 0),
  found integer NOT NULL DEFAULT 0 CHECK (found >= 0),
  take_count integer NOT NULL DEFAULT 0 CHECK (take_count >= 0),
  human_count integer NOT NULL DEFAULT 0 CHECK (human_count >= 0),
  skip_count integer NOT NULL DEFAULT 0 CHECK (skip_count >= 0),
  CHECK (built_in = (key IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS computer_use_directions_enabled ON computer_use_directions(created_at)
  WHERE enabled;

-- Which direction a rotation task came from; NULL for owner goals and platform goals. A deleted
-- owner direction leaves its tasks, steps and findings in place.
ALTER TABLE computer_use_tasks ADD COLUMN IF NOT EXISTS direction_id uuid
  REFERENCES computer_use_directions(id) ON DELETE SET NULL;
