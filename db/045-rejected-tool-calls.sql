-- A call the provider rejected before generation (HTTP 400/401/403/404/422, no usage): nothing
-- was billed, the reservation is released and the task may send a corrected request.
ALTER TABLE tool_calls DROP CONSTRAINT IF EXISTS tool_calls_status_check;
ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_status_check
  CHECK (status IN ('pending','done','uncertain','rejected'));
-- The provider's short explanation of a failed call (error.code / error.message), at most 300
-- characters. Never the request body or credentials.
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS error_detail text
  CHECK (error_detail IS NULL OR length(error_detail) <= 300);
