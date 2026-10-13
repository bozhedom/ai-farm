-- Activated accounts keep their allocation and history. A paused, fully closed
-- portfolio may change strategy parameters while retaining the same connections.
CREATE OR REPLACE FUNCTION execution_guard_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.started_at IS NOT NULL THEN
    IF NEW.capital IS DISTINCT FROM OLD.capital OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      RAISE EXCEPTION 'EXECUTION_ALLOCATION_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    IF NEW.settings IS DISTINCT FROM OLD.settings THEN
      IF NEW.settings->'buyExchange' IS DISTINCT FROM OLD.settings->'buyExchange' OR
        NEW.settings->'sellExchange' IS DISTINCT FROM OLD.settings->'sellExchange' THEN
        RAISE EXCEPTION 'EXECUTION_CONNECTIONS_IMMUTABLE' USING ERRCODE='23514';
      END IF;
      IF OLD.status='stopped' OR
        OLD.reason ~ '^EXECUTION_(DRAWDOWN_STOP|DAILY_LOSS_STOP|INVENTORY_LOSS_STOP|FILL_BUDGET_EXCEEDED)$' OR
        NEW.reason ~ '^EXECUTION_(DRAWDOWN_STOP|DAILY_LOSS_STOP|INVENTORY_LOSS_STOP|FILL_BUDGET_EXCEEDED)$' THEN
        RAISE EXCEPTION 'EXECUTION_RISK_STOP' USING ERRCODE='23514';
      END IF;
      IF OLD.status<>'paused' OR NEW.status<>'paused' THEN
        RAISE EXCEPTION 'EXECUTION_SETTINGS_REQUIRE_PAUSE' USING ERRCODE='23514';
      END IF;
      IF NEW.cash IS DISTINCT FROM OLD.cash OR NEW.equity IS DISTINCT FROM OLD.equity OR
        NEW.realized IS DISTINCT FROM OLD.realized OR NEW.fees IS DISTINCT FROM OLD.fees OR
        NEW.peak IS DISTINCT FROM OLD.peak OR NEW.day_equity IS DISTINCT FROM OLD.day_equity OR
        NEW.risk_day IS DISTINCT FROM OLD.risk_day OR NEW.reason IS DISTINCT FROM OLD.reason OR
        NEW.close_requested IS DISTINCT FROM OLD.close_requested THEN
        RAISE EXCEPTION 'EXECUTION_SETTINGS_HISTORY_IMMUTABLE' USING ERRCODE='23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM execution_operations o WHERE o.track=OLD.track AND o.mode=OLD.mode
        AND (o.closed_at IS NULL OR o.status<>'closed' OR EXISTS
          (SELECT 1 FROM execution_legs l WHERE l.operation_id=o.id AND l.state<>'terminal'))
      ) THEN
        RAISE EXCEPTION 'EXECUTION_SETTINGS_POSITION_OPEN' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A successful run cannot later be relabelled as evidence for another setting.
-- Existing rows deliberately remain without a configuration hash.
CREATE FUNCTION execution_guard_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan IS DISTINCT FROM OLD.plan OR NEW.track IS DISTINCT FROM OLD.track OR NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'EXECUTION_PLAN_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_plan_snapshot BEFORE UPDATE ON execution_operations
  FOR EACH ROW EXECUTE FUNCTION execution_guard_plan();
