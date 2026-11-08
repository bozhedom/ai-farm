-- Residual holdings remain in the existing scoped spot ledger. They may only sell.
-- No existing balances, stops, allocations or orders are changed by this migration.
ALTER TABLE trading_agents ADD COLUMN residual_only boolean NOT NULL DEFAULT false;
ALTER TABLE trading_agents ADD CONSTRAINT trading_residual_live_only
  CHECK (NOT residual_only OR mode='live');
CREATE UNIQUE INDEX trading_residual_symbol ON trading_agents(exchange,mode,symbol)
  WHERE residual_only AND status='active';

CREATE FUNCTION guard_trading_residual_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.side='buy' AND EXISTS (
    SELECT 1 FROM trading_agents WHERE id=NEW.agent_id AND residual_only
  ) THEN
    RAISE EXCEPTION 'TRADING_RESIDUAL_BUY_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trading_residual_order_guard BEFORE INSERT OR UPDATE OF side,agent_id
  ON trading_orders FOR EACH ROW EXECUTE FUNCTION guard_trading_residual_order();
