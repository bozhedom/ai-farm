ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS product_versions (
  product_id uuid NOT NULL REFERENCES products(id),
  version integer NOT NULL CHECK(version > 0),
  hypothesis_id uuid NOT NULL REFERENCES hypotheses(id),
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  spec jsonb NOT NULL,
  checks jsonb NOT NULL,
  is_demo boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(product_id,version)
);
INSERT INTO product_versions(product_id,version,hypothesis_id,strategy_id,spec,checks,is_demo,created_at)
SELECT id,version,hypothesis_id,strategy_id,spec,checks,is_demo,created_at FROM products
ON CONFLICT DO NOTHING;
