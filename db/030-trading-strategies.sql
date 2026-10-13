ALTER TABLE trading_agents DROP CONSTRAINT trading_agents_kind_check;
ALTER TABLE trading_agents ADD CONSTRAINT trading_agents_kind_check
  CHECK (kind IN ('reversion','trend','breakout','grid','dca'));
ALTER TABLE trading_agents ADD CONSTRAINT trading_agents_classic_paper_check
  CHECK (kind NOT IN ('grid','dca') OR mode = 'paper');
ALTER TABLE trading_agents ADD COLUMN strategy_state jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(strategy_state) = 'object');
ALTER TABLE trading_portfolios ADD COLUMN strategy_preset text NOT NULL DEFAULT 'adaptive'
  CHECK (strategy_preset IN ('adaptive','classic'));
ALTER TABLE trading_portfolios ADD COLUMN strategy_preset_pending boolean NOT NULL DEFAULT false;
