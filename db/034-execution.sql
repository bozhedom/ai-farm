CREATE TABLE execution_portfolios (
  track text NOT NULL CHECK (track IN ('arbitrage','funding','defi','prediction')),
  mode text NOT NULL CHECK (mode IN ('paper','demo','live')),
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','paused','stopped','attention')),
  capital numeric(48,18) NOT NULL DEFAULT 0 CHECK (capital>=0),
  cash numeric(48,18) NOT NULL DEFAULT 0,
  realized numeric(48,18) NOT NULL DEFAULT 0,
  fees numeric(48,18) NOT NULL DEFAULT 0,
  equity numeric(48,18) NOT NULL DEFAULT 0,
  peak numeric(48,18) NOT NULL DEFAULT 0,
  day_equity numeric(48,18) NOT NULL DEFAULT 0,
  risk_day text NOT NULL DEFAULT '',
  settings jsonb NOT NULL,
  reason text NOT NULL DEFAULT '',
  heartbeat timestamptz,
  last_scan timestamptz,
  started_at timestamptz,
  close_requested boolean NOT NULL DEFAULT false,
  PRIMARY KEY(track,mode)
);
CREATE TABLE execution_accounts (
  identity text PRIMARY KEY,
  track text NOT NULL,
  mode text NOT NULL,
  venue text NOT NULL,
  snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(track,mode) REFERENCES execution_portfolios(track,mode)
);
CREATE TABLE execution_operations (
  id uuid PRIMARY KEY,
  track text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'opening' CHECK (status IN ('opening','open','closing','closed','attention')),
  reserve numeric(48,18) NOT NULL CHECK(reserve>0),
  plan jsonb NOT NULL,
  pnl numeric(48,18) NOT NULL DEFAULT 0,
  fees numeric(48,18) NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  FOREIGN KEY(track,mode) REFERENCES execution_portfolios(track,mode)
);
CREATE UNIQUE INDEX execution_one_open ON execution_operations(track,mode) WHERE closed_at IS NULL;
CREATE TABLE execution_legs (
  id text PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES execution_operations(id),
  sequence integer NOT NULL CHECK(sequence>=0),
  role text NOT NULL,
  state text NOT NULL CHECK(state IN ('prepared','submitted','terminal','unknown')),
  prepared jsonb NOT NULL,
  receipt jsonb,
  chain_id bigint,
  sender text,
  nonce bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  settled_at timestamptz,
  CHECK (
    (chain_id IS NULL AND sender IS NULL AND nonce IS NULL) OR
    (chain_id IS NOT NULL AND chain_id>0 AND sender IS NOT NULL AND sender ~ '^0x[0-9a-f]{40}$' AND nonce IS NOT NULL AND nonce>=0)
  ),
  CHECK (
    nonce IS NULL OR (
      coalesce(prepared #>> '{intent,venue}','')='aave' AND
      coalesce(prepared #>> '{payload,chainId}','')=chain_id::text AND
      lower(coalesce(prepared #>> '{payload,sender}',''))=sender AND
      coalesce(prepared #>> '{payload,nonce}','')=nonce::text
    )
  ),
  UNIQUE(operation_id,sequence),
  UNIQUE(chain_id,sender,nonce)
);
CREATE TABLE execution_cashflows (
  operation_id uuid NOT NULL REFERENCES execution_operations(id),
  external_id text NOT NULL,
  amount numeric(48,18) NOT NULL,
  kind text NOT NULL CHECK(kind IN ('funding','settlement')),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY(operation_id,kind,external_id)
);
CREATE FUNCTION execution_validate_chain_mode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operation_mode text;
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.prepared IS DISTINCT FROM OLD.prepared OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR
    NEW.chain_id IS DISTINCT FROM OLD.chain_id OR NEW.sender IS DISTINCT FROM OLD.sender OR NEW.nonce IS DISTINCT FROM OLD.nonce
  ) THEN RAISE EXCEPTION 'EXECUTION_PREPARED_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF coalesce(NEW.prepared #>> '{intent,venue}','')='aave' THEN
    SELECT mode INTO operation_mode FROM execution_operations WHERE id=NEW.operation_id;
    -- Preparation can fail before any signature/nonce exists. Keep its terminal audit row,
    -- but never turn it into a sendable operation or free an existing nonce reservation.
    IF NEW.state='terminal' AND NEW.submitted_at IS NULL AND NEW.prepared->'payload'='{}'::jsonb AND
      NEW.prepared->'externalId'='null'::jsonb AND NOT (NEW.receipt ? 'networkFee') AND
      NEW.receipt @> '{"status":"rejected","externalId":null,"filledQuantity":"0","grossQuote":"0","quoteFee":"0","baseFee":"0"}'::jsonb THEN
      RETURN NEW;
    END IF;
    IF operation_mode='paper' THEN
      IF NEW.nonce IS NOT NULL THEN RAISE EXCEPTION 'EXECUTION_PAPER_NONCE_FORBIDDEN' USING ERRCODE='23514'; END IF;
    ELSIF NEW.nonce IS NULL OR coalesce(NEW.prepared #>> '{payload,paper}','')='true' THEN
      RAISE EXCEPTION 'EXECUTION_CHAIN_NONCE_REQUIRED' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_chain_mode BEFORE INSERT OR UPDATE ON execution_legs
  FOR EACH ROW EXECUTE FUNCTION execution_validate_chain_mode();
CREATE TABLE execution_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  track text NOT NULL,
  mode text NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(track,mode) REFERENCES execution_portfolios(track,mode)
);
CREATE INDEX execution_events_scope ON execution_events(track,mode,id DESC);
-- One real exchange identity cannot back two independent ledgers, including legacy spot.
CREATE TABLE execution_account_owners(identity text PRIMARY KEY, owner text NOT NULL);
INSERT INTO execution_account_owners(identity,owner)
SELECT account_identity,'spot:'||exchange||':'||mode FROM trading_portfolios WHERE account_identity IS NOT NULL;
CREATE FUNCTION execution_claim_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_key text; owner_key text; claimed text;
BEGIN
  IF TG_TABLE_NAME='trading_portfolios' THEN
    account_key := NEW.account_identity; owner_key := 'spot:'||NEW.exchange||':'||NEW.mode;
  ELSE
    account_key := NEW.identity; owner_key := 'execution:'||NEW.track||':'||NEW.mode||':'||NEW.venue;
  END IF;
  IF account_key IS NULL THEN RETURN NEW; END IF;
  INSERT INTO execution_account_owners(identity,owner) VALUES(account_key,owner_key)
    ON CONFLICT(identity) DO UPDATE SET owner=EXCLUDED.owner WHERE execution_account_owners.owner=EXCLUDED.owner
    RETURNING owner INTO claimed;
  IF claimed IS NULL THEN RAISE EXCEPTION 'EXECUTION_ACCOUNT_ALREADY_USED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_claim_spot BEFORE INSERT OR UPDATE OF account_identity ON trading_portfolios FOR EACH ROW EXECUTE FUNCTION execution_claim_account();
CREATE TRIGGER execution_claim_new BEFORE INSERT ON execution_accounts FOR EACH ROW EXECUTE FUNCTION execution_claim_account();
-- Allocations are immutable after activation, including direct SQL callers.
CREATE FUNCTION execution_guard_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.started_at IS NOT NULL AND (NEW.capital<>OLD.capital OR NEW.settings<>OLD.settings OR NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
    RAISE EXCEPTION 'EXECUTION_ALLOCATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_allocation BEFORE UPDATE ON execution_portfolios FOR EACH ROW EXECUTE FUNCTION execution_guard_allocation();
