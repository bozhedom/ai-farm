-- Expand symbols without rewriting any existing fills, balances or history.
ALTER TABLE trading_agents DROP CONSTRAINT trading_agents_symbol_check;
ALTER TABLE trading_agents ADD CONSTRAINT trading_agents_symbol_check CHECK (symbol ~ '^[A-Z0-9]{1,32}-USDT$' AND symbol <> 'USDT-USDT');
ALTER TABLE trading_orders DROP CONSTRAINT trading_orders_symbol_check;
ALTER TABLE trading_orders ADD CONSTRAINT trading_orders_symbol_check CHECK (symbol ~ '^[A-Z0-9]{1,32}-USDT$' AND symbol <> 'USDT-USDT');
ALTER TABLE trading_markets DROP CONSTRAINT trading_markets_symbol_check;
ALTER TABLE trading_markets ADD CONSTRAINT trading_markets_symbol_check CHECK (symbol ~ '^[A-Z0-9]{1,32}-USDT$' AND symbol <> 'USDT-USDT');

ALTER TABLE trading_agents ADD COLUMN selector_version text NOT NULL DEFAULT 'fixed-v1';
ALTER TABLE trading_agents ADD COLUMN assigned_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE trading_agents ADD COLUMN position_opened_at timestamptz;
UPDATE trading_agents a SET position_opened_at = coalesce(
  (SELECT max(o.created_at) FROM trading_orders o WHERE o.agent_id=a.id AND o.side='buy' AND o.filled_qty>0),
  a.last_order_at,a.created_at
) WHERE a.base>0;

CREATE TABLE trading_scouts (
  exchange text NOT NULL,
  mode text NOT NULL,
  policy_version text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  scanned_at timestamptz,
  error text NOT NULL DEFAULT '',
  coins jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(coins)='array'),
  PRIMARY KEY(exchange,mode),
  FOREIGN KEY(exchange,mode) REFERENCES trading_portfolios(exchange,mode)
);

CREATE TABLE trading_assignments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exchange text NOT NULL,
  mode text NOT NULL,
  agent_id uuid NOT NULL,
  symbol text NOT NULL CHECK (symbol ~ '^[A-Z0-9]{1,32}-USDT$' AND symbol <> 'USDT-USDT'),
  previous_symbol text,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(agent_id,exchange,mode) REFERENCES trading_agents(id,exchange,mode)
);
CREATE INDEX trading_assignments_history ON trading_assignments(exchange,mode,created_at DESC);
