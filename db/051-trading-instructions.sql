CREATE TABLE trading_instructions (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  profile_revision integer NOT NULL DEFAULT 0,
  rules jsonb NOT NULL DEFAULT '{}',
  manager_notes jsonb NOT NULL DEFAULT '[]',
  source text CHECK(source IN ('parser','model')),
  applied_at timestamptz
);
INSERT INTO trading_instructions(id) VALUES(true);
CREATE TABLE trading_instruction_requests (
  id uuid PRIMARY KEY,
  request_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('running','done','failed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX trading_instruction_requests_created ON trading_instruction_requests(created_at);
ALTER TABLE budget_reservations DROP CONSTRAINT budget_reservations_category_check;
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_category_check
  CHECK(category IN ('research','order','scout','lead','report','trading_manager','computer_use','assistant','trading_instructions'));
ALTER TABLE trading_manager ADD COLUMN instruction_revision integer NOT NULL DEFAULT 0;
ALTER TABLE trading_manager_runs ADD COLUMN instruction_revision integer NOT NULL DEFAULT 0;
ALTER TABLE trading_manager_tasks ADD COLUMN instruction_revision integer NOT NULL DEFAULT 0;
