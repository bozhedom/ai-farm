-- A product build from an accepted idea failed its checks: the idea waits for the owner
-- ('needs_human') with the reason in words. Additive and safe to re-run.
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS build_error text;
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS build_failed_at timestamptz;
ALTER TABLE ideas DROP CONSTRAINT IF EXISTS ideas_build_error_length;
ALTER TABLE ideas ADD CONSTRAINT ideas_build_error_length
  CHECK (build_error IS NULL OR length(build_error) <= 600);
