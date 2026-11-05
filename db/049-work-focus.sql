CREATE TABLE work_focus (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  selected text[] NOT NULL DEFAULT ARRAY['trading','manager','arbitrage','funding','defi','monitor'],
  until_at timestamptz,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(selected) BETWEEN 1 AND 10),
  CHECK (selected <@ ARRAY['trading','manager','arbitrage','funding','defi','prediction','monitor','studio','computer','services']::text[])
);
INSERT INTO work_focus(id) VALUES(true);
