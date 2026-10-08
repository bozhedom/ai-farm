-- Existing installations retain one rotating research job per UTC day until the owner opts in.
ALTER TABLE system_state ADD COLUMN IF NOT EXISTS research_scope text NOT NULL DEFAULT 'rotate'
  CHECK (research_scope IN ('rotate','all'));
