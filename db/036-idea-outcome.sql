-- The owner finishes a "needs a person" idea and records how it went. The outcome is the
-- owner's statement, not revenue: the money ledger and payments stay untouched. Selection
-- uses it as one quality component of the agent that found the idea.
-- Additive and safe to re-run.
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS owner_outcome text;
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS owner_outcome_at timestamptz;
ALTER TABLE ideas DROP CONSTRAINT IF EXISTS ideas_owner_status;
ALTER TABLE ideas ADD CONSTRAINT ideas_owner_status
  CHECK (owner_status IS NULL OR owner_status IN ('taken', 'done'));
ALTER TABLE ideas DROP CONSTRAINT IF EXISTS ideas_owner_outcome;
-- CASE, not OR: a NULL owner_status must not let a stray outcome through.
ALTER TABLE ideas ADD CONSTRAINT ideas_owner_outcome CHECK (
  CASE WHEN owner_status IS NOT DISTINCT FROM 'done'
    THEN owner_outcome IN ('worked', 'failed') AND owner_outcome_at IS NOT NULL
    ELSE owner_outcome IS NULL AND owner_outcome_at IS NULL
  END
);
CREATE INDEX IF NOT EXISTS ideas_owner_done ON ideas(strategy_id, generation)
  WHERE owner_status = 'done';
