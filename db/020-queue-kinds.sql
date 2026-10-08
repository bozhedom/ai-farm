-- New farm job kinds and budget categories. CHECK constraints only widen.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check
  CHECK (kind IN ('research','fulfill','evaluate','scout','lead','report','evolve'));
ALTER TABLE budget_reservations DROP CONSTRAINT IF EXISTS budget_reservations_category_check;
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_category_check
  CHECK (category IN ('research','order','scout','lead','report'));
CREATE INDEX IF NOT EXISTS jobs_kind_status ON jobs(kind, status, run_after);
