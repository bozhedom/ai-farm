-- Continuous coverage cursor for deposit sync. Without it, a worker outage longer than Bybit's
-- 30-day request window permanently skips successful deposits that never reappear in the API.
ALTER TABLE wallet_sync
  ADD COLUMN IF NOT EXISTS synced_through timestamptz;
