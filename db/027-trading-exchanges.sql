-- Preserve the original OKX experiment, including every order ID and archived generation.
ALTER TABLE trading_portfolios ADD COLUMN exchange text NOT NULL DEFAULT 'okx'
  CHECK (exchange IN ('okx','bybit','binance','bitget'));
ALTER TABLE trading_portfolios DROP CONSTRAINT trading_portfolios_capital_check;
ALTER TABLE trading_portfolios ADD CHECK (capital >= 0 AND capital <= 100000000000000000000);

ALTER TABLE trading_agents ADD COLUMN exchange text NOT NULL DEFAULT 'okx';
ALTER TABLE trading_orders ADD COLUMN exchange text NOT NULL DEFAULT 'okx';
ALTER TABLE trading_equity ADD COLUMN exchange text NOT NULL DEFAULT 'okx';
ALTER TABLE trading_events ADD COLUMN exchange text NOT NULL DEFAULT 'okx';
ALTER TABLE trading_markets ADD COLUMN exchange text NOT NULL DEFAULT 'okx';

ALTER TABLE trading_agents DROP CONSTRAINT trading_agents_mode_fkey;
ALTER TABLE trading_orders DROP CONSTRAINT trading_orders_mode_fkey;
ALTER TABLE trading_equity DROP CONSTRAINT trading_equity_mode_fkey;
ALTER TABLE trading_events DROP CONSTRAINT trading_events_mode_fkey;
ALTER TABLE trading_markets DROP CONSTRAINT trading_markets_mode_fkey;
ALTER TABLE trading_portfolios DROP CONSTRAINT trading_portfolios_pkey;
ALTER TABLE trading_portfolios ADD PRIMARY KEY (exchange,mode);
ALTER TABLE trading_agents ADD FOREIGN KEY (exchange,mode) REFERENCES trading_portfolios(exchange,mode);
ALTER TABLE trading_orders ADD FOREIGN KEY (exchange,mode) REFERENCES trading_portfolios(exchange,mode);
ALTER TABLE trading_equity ADD FOREIGN KEY (exchange,mode) REFERENCES trading_portfolios(exchange,mode);
ALTER TABLE trading_events ADD FOREIGN KEY (exchange,mode) REFERENCES trading_portfolios(exchange,mode);
ALTER TABLE trading_markets ADD FOREIGN KEY (exchange,mode) REFERENCES trading_portfolios(exchange,mode);

-- An order can only spend its own portfolio; lineage can cross modes, never exchanges.
ALTER TABLE trading_agents ADD UNIQUE (exchange,mode,id);
ALTER TABLE trading_agents ADD UNIQUE (exchange,id);
ALTER TABLE trading_orders DROP CONSTRAINT trading_orders_agent_id_fkey;
ALTER TABLE trading_orders ADD FOREIGN KEY (exchange,mode,agent_id) REFERENCES trading_agents(exchange,mode,id);
ALTER TABLE trading_agents DROP CONSTRAINT trading_agents_parent_id_fkey;
ALTER TABLE trading_agents ADD FOREIGN KEY (exchange,parent_id) REFERENCES trading_agents(exchange,id);

DROP INDEX trading_one_unresolved;
CREATE UNIQUE INDEX trading_one_unresolved ON trading_orders(exchange,mode)
  WHERE status IN ('prepared','submitted','unknown');
ALTER TABLE trading_equity DROP CONSTRAINT trading_equity_pkey;
ALTER TABLE trading_equity ADD PRIMARY KEY (exchange,mode,at);
ALTER TABLE trading_markets DROP CONSTRAINT trading_markets_pkey;
ALTER TABLE trading_markets ADD PRIMARY KEY (exchange,mode,symbol);
DROP INDEX trading_agents_active;
CREATE INDEX trading_agents_active ON trading_agents(exchange,mode,status);
DROP INDEX trading_orders_history;
CREATE INDEX trading_orders_history ON trading_orders(exchange,mode,created_at DESC);
DROP INDEX trading_events_history;
CREATE INDEX trading_events_history ON trading_events(exchange,mode,created_at DESC);

-- Only OKX retains the existing live allocation. Adding a venue never multiplies real capital.
INSERT INTO trading_portfolios(exchange,mode,capital,peak,day_equity)
SELECT e,m,CASE WHEN m='live' THEN 0 ELSE 100000000000000000000 END,
  CASE WHEN m='live' THEN 0 ELSE 100000000000000000000 END,
  CASE WHEN m='live' THEN 0 ELSE 100000000000000000000 END
FROM unnest(ARRAY['bybit','binance','bitget']) e
CROSS JOIN unnest(ARRAY['paper','demo','live']) m;
