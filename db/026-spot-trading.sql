-- Trading uses its own ledger; test orders/payments and ruble budgets remain untouched.
CREATE TABLE trading_portfolios (
  mode text PRIMARY KEY CHECK (mode IN ('paper','demo','live')),
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','paused','stopped')),
  reason text NOT NULL DEFAULT '',
  capital numeric(60,0) NOT NULL DEFAULT 100000000000000000000 CHECK (capital > 0 AND capital <= 100000000000000000000),
  peak numeric(60,0) NOT NULL DEFAULT 100000000000000000000,
  day_equity numeric(60,0) NOT NULL DEFAULT 100000000000000000000,
  risk_day text NOT NULL DEFAULT '',
  account_identity text,
  quote_offset numeric(60,0) NOT NULL DEFAULT 0,
  checked_at timestamptz,
  check_error text NOT NULL DEFAULT '',
  heartbeat timestamptz,
  last_tick timestamptz,
  started_at timestamptz,
  demo_probe boolean NOT NULL DEFAULT false,
  generation integer NOT NULL DEFAULT 1,
  evolution_at timestamptz,
  evolution_reason text NOT NULL DEFAULT 'COLLECTING_DATA'
);
INSERT INTO trading_portfolios(mode) VALUES ('paper'),('demo'),('live');

CREATE TABLE trading_agents (
  id uuid PRIMARY KEY,
  mode text NOT NULL REFERENCES trading_portfolios(mode),
  name text NOT NULL,
  symbol text NOT NULL CHECK (symbol IN ('BTC-USDT','ETH-USDT')),
  kind text NOT NULL CHECK (kind IN ('reversion','trend','breakout')),
  params jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  parent_id uuid REFERENCES trading_agents(id),
  generation integer NOT NULL,
  initial_cash numeric(60,0) NOT NULL CHECK (initial_cash > 0),
  cash numeric(60,0) NOT NULL CHECK (cash >= 0),
  base numeric(60,0) NOT NULL DEFAULT 0 CHECK (base >= 0),
  basis numeric(60,0) NOT NULL DEFAULT 0 CHECK (basis >= 0),
  realized numeric(60,0) NOT NULL DEFAULT 0,
  fees numeric(60,0) NOT NULL DEFAULT 0,
  peak numeric(60,0) NOT NULL,
  max_drawdown_bps integer NOT NULL DEFAULT 0,
  round_trips integer NOT NULL DEFAULT 0,
  last_order_at timestamptz,
  last_signal text NOT NULL DEFAULT 'WAITING_MARKET',
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX trading_agents_active ON trading_agents(mode,status);

CREATE TABLE trading_orders (
  id uuid PRIMARY KEY,
  mode text NOT NULL REFERENCES trading_portfolios(mode),
  agent_id uuid NOT NULL REFERENCES trading_agents(id),
  client_id text NOT NULL UNIQUE CHECK (client_id ~ '^[a-zA-Z0-9]{1,32}$'),
  symbol text NOT NULL CHECK (symbol IN ('BTC-USDT','ETH-USDT')),
  side text NOT NULL CHECK (side IN ('buy','sell')),
  qty numeric(60,0) NOT NULL CHECK (qty > 0),
  price numeric(60,0) NOT NULL CHECK (price > 0),
  status text NOT NULL CHECK (status IN ('prepared','submitted','unknown','filled','canceled','rejected')),
  reason text NOT NULL,
  exchange_id text,
  filled_qty numeric(60,0) NOT NULL DEFAULT 0,
  quote numeric(60,0) NOT NULL DEFAULT 0,
  base_fee numeric(60,0) NOT NULL DEFAULT 0,
  quote_fee numeric(60,0) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
-- Only one unresolved order per portfolio. Its assets cannot be reserved a second time.
CREATE UNIQUE INDEX trading_one_unresolved ON trading_orders(mode)
  WHERE status IN ('prepared','submitted','unknown');
CREATE INDEX trading_orders_history ON trading_orders(mode,created_at DESC);

CREATE TABLE trading_equity (
  mode text NOT NULL REFERENCES trading_portfolios(mode),
  at timestamptz NOT NULL DEFAULT now(),
  equity numeric(60,0) NOT NULL,
  cash numeric(60,0) NOT NULL,
  exposure numeric(60,0) NOT NULL,
  PRIMARY KEY(mode,at)
);
CREATE TABLE trading_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mode text NOT NULL REFERENCES trading_portfolios(mode),
  kind text NOT NULL,
  reason text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trading_events_history ON trading_events(mode,created_at DESC);

CREATE TABLE trading_markets (
  mode text NOT NULL REFERENCES trading_portfolios(mode),
  symbol text NOT NULL CHECK (symbol IN ('BTC-USDT','ETH-USDT')),
  at timestamptz NOT NULL,
  bid numeric(60,0) NOT NULL,
  ask numeric(60,0) NOT NULL,
  PRIMARY KEY(mode,symbol)
);
