-- Public research has no balance, order or wallet authority.
CREATE TABLE earnings_monitor (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  requested_at timestamptz,
  attempted_at timestamptz,
  finished_at timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  report jsonb,
  arbitrage jsonb,
  error text NOT NULL DEFAULT '',
  CHECK (report IS NULL OR jsonb_typeof(report)='object'),
  CHECK (arbitrage IS NULL OR jsonb_typeof(arbitrage)='object')
);
INSERT INTO earnings_monitor(id) VALUES(true);
