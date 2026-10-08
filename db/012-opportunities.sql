CREATE TABLE IF NOT EXISTS opportunities (
  id uuid PRIMARY KEY,
  template text NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  snippet text NOT NULL,
  is_demo boolean NOT NULL,
  first_job_id uuid NOT NULL REFERENCES jobs(id),
  last_job_id uuid NOT NULL REFERENCES jobs(id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','saved','contacted','won','dismissed')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(template,url,is_demo)
);
CREATE INDEX IF NOT EXISTS opportunities_recent ON opportunities(last_seen_at DESC);
UPDATE system_state SET policy_version='v2' WHERE id=true;
ALTER TABLE system_state ALTER COLUMN policy_version SET DEFAULT 'v2';
