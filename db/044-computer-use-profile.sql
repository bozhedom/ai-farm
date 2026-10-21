-- Performer profile (21.10.2026): the owner's own, truthful description of the person behind the
-- freelance accounts. The computer-use model writes proposals in first person and may use only
-- facts from here; the server enforces the minimum price and the proposal limit from it. One row,
-- validated by zod in core/computer-use/profile.ts before every write. Additive only.
CREATE TABLE IF NOT EXISTS computer_use_profile (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
