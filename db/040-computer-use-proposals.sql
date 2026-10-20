-- Computer use on freelance platforms (owner decision of 20.10.2026): the model assesses found
-- jobs itself, drafts proposals and sends them through single-use permits, writes deliverables
-- and answers clients; the owner logs platforms in once through the remote-control panel.
-- Everything outward still passes server policy; proposals, documents and permits are durable
-- records, never revenue. Additive only.

-- Owner switch for autonomous sending (default off; the env gate COMPUTER_USE_AUTO_PROPOSALS
-- must be on as well) and the owner's manual-control lease: while it lasts, no model step runs.
ALTER TABLE computer_use ADD COLUMN IF NOT EXISTS auto_proposals boolean NOT NULL DEFAULT false;
ALTER TABLE computer_use ADD COLUMN IF NOT EXISTS manual_until timestamptz;
ALTER TABLE computer_use ADD COLUMN IF NOT EXISTS manual_session_id text;

-- Self-assessment of a found job. The server forces decision='skip' when the job forbids AI.
ALTER TABLE computer_use_opportunities ADD COLUMN IF NOT EXISTS decision text NOT NULL DEFAULT 'human'
  CHECK (decision IN ('take','human','skip'));
ALTER TABLE computer_use_opportunities ADD COLUMN IF NOT EXISTS fit integer NOT NULL DEFAULT 0
  CHECK (fit BETWEEN 0 AND 100);
ALTER TABLE computer_use_opportunities ADD COLUMN IF NOT EXISTS ai_forbidden boolean NOT NULL DEFAULT false;
-- Integer minor units of the named currency (kopecks, cents); never a float.
ALTER TABLE computer_use_opportunities ADD COLUMN IF NOT EXISTS estimated_value_minor bigint
  CHECK (estimated_value_minor IS NULL OR estimated_value_minor >= 0);
ALTER TABLE computer_use_opportunities ADD COLUMN IF NOT EXISTS estimated_currency text
  CHECK (estimated_currency IS NULL OR estimated_currency ~ '^[A-Z]{3}$');
ALTER TABLE computer_use_opportunities ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT ''
  CHECK (length(reason) <= 500);
ALTER TABLE computer_use_opportunities ADD COLUMN IF NOT EXISTS platform_domain text NOT NULL DEFAULT '';

-- Platforms where the owner logged the browser profile in. Marked by the owner, read by the
-- goal rotation and the proposal checks.
CREATE TABLE IF NOT EXISTS computer_use_platforms (
  domain text PRIMARY KEY CHECK (domain ~ '^[a-z0-9.-]{3,100}$'),
  logged_in boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A proposal the model drafted; `sent` only after the permitted click ran on the VM.
CREATE TABLE IF NOT EXISTS computer_use_proposals (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES computer_use_tasks(id),
  step_no integer NOT NULL,
  opportunity_id uuid REFERENCES computer_use_opportunities(id),
  opportunity_url text NOT NULL CHECK (length(opportunity_url) <= 2000),
  platform_domain text NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 200 AND 3000),
  price_amount bigint CHECK (price_amount IS NULL OR price_amount >= 0),
  price_currency text CHECK (price_currency IS NULL OR price_currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','failed','expired')),
  is_demo boolean NOT NULL,
  sent_url text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS computer_use_proposals_recent ON computer_use_proposals(created_at DESC);
CREATE INDEX IF NOT EXISTS computer_use_proposals_daily ON computer_use_proposals(platform_domain, created_at);

-- Deliverables written by a separate paid model call; typed into the platform by type_stored.
CREATE TABLE IF NOT EXISTS computer_use_documents (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES computer_use_tasks(id),
  step_no integer NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 4 AND 160),
  brief text NOT NULL CHECK (length(brief) BETWEEN 20 AND 3000),
  kind text NOT NULL CHECK (kind IN ('article','product_description','translation','summary','instruction','reply','other')),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 12000),
  is_demo boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS computer_use_documents_recent ON computer_use_documents(created_at DESC);

-- A single-use permit: one outward click or Enter on one platform within 15 minutes, for the
-- task that asked. Consumed before the VM acts, so a permitted send runs at most once.
CREATE TABLE IF NOT EXISTS computer_use_send_permits (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES computer_use_tasks(id),
  platform_domain text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('proposal','delivery','reply')),
  proposal_id uuid REFERENCES computer_use_proposals(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','used','expired','superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_step_no integer,
  used_url text NOT NULL DEFAULT '',
  CHECK ((status = 'used') = (used_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS computer_use_one_open_permit ON computer_use_send_permits(task_id)
  WHERE status='open';
CREATE INDEX IF NOT EXISTS computer_use_permits_daily ON computer_use_send_permits(platform_domain, created_at);
