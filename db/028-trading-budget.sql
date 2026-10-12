-- The initial 100 USDT example is a default, not the owner's funding limit.
-- Preserve allocations and risk history. The upper bound matches exact integer API input.
ALTER TABLE trading_portfolios DROP CONSTRAINT trading_portfolios_capital_check;
ALTER TABLE trading_portfolios ADD CONSTRAINT trading_portfolios_capital_check
  CHECK (capital >= 0 AND capital <= 9007199254740991::numeric * 1000000000000000000);
