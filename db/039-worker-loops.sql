-- One heartbeat row per worker loop: each loop records its own success or failure, so one
-- failing loop is visible without hiding the others.
CREATE TABLE IF NOT EXISTS worker_loops (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9:_-]{0,63}$'),
  started_at timestamptz,
  ok_at timestamptz,
  error_at timestamptz,
  error text NOT NULL DEFAULT '',
  runs bigint NOT NULL DEFAULT 0,
  failures bigint NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0
);

-- The server autopilot's last pass: what it found and decided, for the office and the check.
CREATE TABLE IF NOT EXISTS autopilot_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  checked_at timestamptz,
  decisions jsonb NOT NULL DEFAULT '[]'
);
INSERT INTO autopilot_state(id) VALUES (true) ON CONFLICT DO NOTHING;
