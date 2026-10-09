-- Hour (UTC) when the daily farm run may start. 0 keeps the old behaviour (start of the UTC
-- day). At most 20, so a run has hours left before the UTC day and its slots end.
ALTER TABLE system_state ADD COLUMN IF NOT EXISTS schedule_hour_utc smallint NOT NULL DEFAULT 0;
ALTER TABLE system_state DROP CONSTRAINT IF EXISTS system_state_schedule_hour;
ALTER TABLE system_state ADD CONSTRAINT system_state_schedule_hour
  CHECK (schedule_hour_utc BETWEEN 0 AND 20);
