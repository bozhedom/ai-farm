-- Leads are linked to products and get a reply draft. A person sends it; the farm never does.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS reply_draft text CHECK (length(reply_draft) <= 1200);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS reply_drafted_at timestamptz;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS reply_job_id uuid REFERENCES jobs(id);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS reply_error text;
CREATE INDEX IF NOT EXISTS opportunities_product ON opportunities(product_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS manager_reports (
  id uuid PRIMARY KEY,
  report_key text UNIQUE NOT NULL,           -- 'report:daily:YYYY-MM-DD' | 'report:weekly:<n>'
  kind text NOT NULL CHECK (kind IN ('daily','weekly')),
  job_id uuid NOT NULL REFERENCES jobs(id),
  generation integer NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  metrics jsonb NOT NULL,                    -- server numbers
  ranking jsonb NOT NULL,                    -- [{ideaId, rankScore, status}]
  narrative jsonb,                           -- model answer by reportSchema; null when unavailable
  is_demo boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS manager_reports_recent ON manager_reports(created_at DESC);
