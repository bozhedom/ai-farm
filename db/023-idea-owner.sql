-- The owner takes one "needs a person" idea into work: one hypothesis under the owner's
-- control. A separate mark next to the farm status, so existing statuses keep their meaning.
-- Additive and safe to re-run.
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS owner_status text;
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS owner_taken_at timestamptz;
ALTER TABLE ideas DROP CONSTRAINT IF EXISTS ideas_owner_status;
ALTER TABLE ideas ADD CONSTRAINT ideas_owner_status
  CHECK (owner_status IS NULL OR owner_status = 'taken');
CREATE INDEX IF NOT EXISTS ideas_owner_taken ON ideas(owner_taken_at DESC)
  WHERE owner_status = 'taken';
