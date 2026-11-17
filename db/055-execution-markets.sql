-- Additional execution books: directional perps, multi-venue funding, margin, earn, swaps, options.
-- Live remains disabled until EXECUTION_LIVE_ENABLED and accepted tracks are set by the owner.

ALTER TABLE execution_portfolios DROP CONSTRAINT IF EXISTS execution_portfolios_track_check;
ALTER TABLE execution_portfolios
  ADD CONSTRAINT execution_portfolios_track_check
  CHECK (track IN (
    'arbitrage','funding','defi','prediction','futures','margin','earn','swap','options'
  ));

ALTER TABLE execution_cashflows DROP CONSTRAINT IF EXISTS execution_cashflows_kind_check;
ALTER TABLE execution_cashflows
  ADD CONSTRAINT execution_cashflows_kind_check
  CHECK (kind IN ('funding','settlement','interest','premium','yield'));

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'execution_legs'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%aave%'
  LOOP
    EXECUTE format('ALTER TABLE execution_legs DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE execution_legs ADD CONSTRAINT execution_legs_nonce_venue CHECK (
  nonce IS NULL OR (
    coalesce(prepared #>> '{intent,venue}','') IN ('aave','uniswap') AND
    coalesce(prepared #>> '{payload,chainId}','')=chain_id::text AND
    lower(coalesce(prepared #>> '{payload,sender}',''))=sender AND
    coalesce(prepared #>> '{payload,nonce}','')=nonce::text
  )
);
