-- Environment authorization remains an upper bound; this switch cannot enable paid work by itself.
ALTER TABLE system_state ADD COLUMN IF NOT EXISTS schedule_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE system_state ADD COLUMN IF NOT EXISTS provider_readiness jsonb;
