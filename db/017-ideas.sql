-- Farm ideas on any legal topic from the server taxonomy (core/taxonomy.ts). Additive only.
CREATE TABLE IF NOT EXISTS topic_scouting (
  topic_id text PRIMARY KEY,                 -- id from core/taxonomy.ts
  category text NOT NULL,
  scout_count integer NOT NULL DEFAULT 0,
  last_scouted_at timestamptz,
  last_strategy_id uuid REFERENCES strategies(id),
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS ideas (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  generation integer NOT NULL,
  topic_id text NOT NULL,
  category text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 4 AND 120),
  fingerprint text NOT NULL,                 -- normalized title and audience tokens
  duplicate_of uuid REFERENCES ideas(id),
  research jsonb NOT NULL,                   -- scout answer validated by ideaSchema
  evidence jsonb NOT NULL,                   -- Evidence[] from the server search
  critique jsonb NOT NULL,                   -- {verdict, reason}
  farm_executable boolean NOT NULL,
  suggested_template text,
  rank_score integer NOT NULL DEFAULT 0 CHECK (rank_score BETWEEN 0 AND 100),
  status text NOT NULL CHECK (status IN ('new','accepted','needs_human','rejected','productized')),
  owner_note text NOT NULL DEFAULT '' CHECK (length(owner_note) <= 1000),
  is_demo boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ranked_at timestamptz,
  UNIQUE (job_id, topic_id),
  CHECK (NOT farm_executable OR suggested_template IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ideas_fingerprint ON ideas(fingerprint);
CREATE INDEX IF NOT EXISTS ideas_strategy_generation ON ideas(strategy_id, generation, created_at);
CREATE INDEX IF NOT EXISTS ideas_status ON ideas(status, rank_score DESC);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_idea_fk;
ALTER TABLE products ADD CONSTRAINT products_idea_fk FOREIGN KEY (idea_id) REFERENCES ideas(id);
ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS idea_id uuid REFERENCES ideas(id);
CREATE INDEX IF NOT EXISTS hypotheses_idea ON hypotheses(idea_id) WHERE idea_id IS NOT NULL;
