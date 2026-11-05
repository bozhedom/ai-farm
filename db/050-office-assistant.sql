ALTER TABLE budget_reservations DROP CONSTRAINT budget_reservations_category_check;
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_category_check
  CHECK (category IN ('research','order','scout','lead','report','trading_manager','computer_use','assistant'));
CREATE TABLE assistant_requests (
  id uuid PRIMARY KEY,
  request_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('running','done','failed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX assistant_requests_created ON assistant_requests(created_at);
