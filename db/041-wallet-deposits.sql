-- Deposits to the owner's Bybit account, read with a separate read-only key. Real money in its
-- own coin: never converted to rubles and never mixed with test payments. A deposit counts as
-- income only after the owner marks it so; own transfers between accounts are "not_income".
CREATE TABLE IF NOT EXISTS wallet_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- onchain: /v5/asset/deposit/query-record; internal: Bybit-to-Bybit transfer by UID/email.
  source text NOT NULL CHECK (source IN ('onchain', 'internal')),
  -- onchain: txID:txIndex; internal: Bybit record id. Stable across syncs.
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  tx_id text NOT NULL DEFAULT '' CHECK (length(tx_id) <= 200),
  coin text NOT NULL CHECK (coin ~ '^[A-Z0-9]{1,20}$'),
  chain text NOT NULL DEFAULT '' CHECK (length(chain) <= 40),
  -- Exact decimal string as Bybit reported it, and the same value in integer minor units.
  amount text NOT NULL CHECK (amount ~ '^\d{1,24}(\.\d{1,36})?$'),
  amount_minor numeric(60, 0) NOT NULL CHECK (amount_minor >= 0),
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  status text NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  raw_status integer NOT NULL,
  confirmations text NOT NULL DEFAULT '' CHECK (length(confirmations) <= 40),
  success_at timestamptz,
  classification text NOT NULL DEFAULT 'unclassified'
    CHECK (classification IN ('unclassified', 'income', 'not_income')),
  classified_at timestamptz,
  -- Minimal fields for the owner: address, tag, fee, sender of an internal transfer.
  raw jsonb NOT NULL DEFAULT '{}',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id),
  CHECK (status <> 'success' OR success_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS wallet_deposits_success_idx
  ON wallet_deposits (success_at DESC) WHERE status = 'success';
CREATE INDEX IF NOT EXISTS wallet_deposits_recent_idx
  ON wallet_deposits (coalesce(success_at, first_seen_at) DESC);

-- Key check and last sync, for the office and "needs a person".
CREATE TABLE IF NOT EXISTS wallet_sync (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  key_status text NOT NULL DEFAULT 'not_configured'
    CHECK (key_status IN ('not_configured', 'read_only', 'rejected', 'error')),
  key_error text NOT NULL DEFAULT '',
  key_checked_at timestamptz,
  synced_at timestamptz,
  sync_error text NOT NULL DEFAULT '',
  sync_error_at timestamptz,
  rows_seen integer NOT NULL DEFAULT 0
);
INSERT INTO wallet_sync(id) VALUES (true) ON CONFLICT DO NOTHING;
