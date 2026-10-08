-- Shared foundation for the public site and the farm. Additive only; safe to re-run.

-- Product: public fields. Existing products stay private until the owner publishes them.
ALTER TABLE products ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'service' CHECK (kind IN ('service'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_kopecks integer NOT NULL DEFAULT 49900
  CHECK (price_kopecks > 0 AND price_kopecks <= 10000000);
ALTER TABLE products ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private','public'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE products ADD COLUMN IF NOT EXISTS page jsonb NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS idea_id uuid;            -- FK is added by 017

-- template is unique, so the slug is too. Same rule as publicSlug() in core/storefront.ts.
UPDATE products SET slug = replace(template, '_', '-') WHERE slug IS NULL;
-- Starting prices per template, same as defaultPriceKopecks in core/storefront.ts.
UPDATE products SET price_kopecks = CASE template
    WHEN 'description' THEN 49000
    WHEN 'faq' THEN 149000
    WHEN 'social' THEN 79000
    WHEN 'proofreading' THEN 49000
    WHEN 'translation' THEN 89000
    WHEN 'summary' THEN 49000
    WHEN 'email' THEN 29000
    WHEN 'landing' THEN 199000
    WHEN 'proposal' THEN 149000
    WHEN 'instruction' THEN 79000
    WHEN 'lesson' THEN 79000
    WHEN 'job_post' THEN 69000
    ELSE price_kopecks
  END
  WHERE NOT EXISTS (SELECT 1 FROM migrations WHERE name = '014-foundation.sql');
ALTER TABLE products ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS products_slug ON products(slug);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_slug_format;
ALTER TABLE products ADD CONSTRAINT products_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$');
ALTER TABLE product_versions ADD COLUMN IF NOT EXISTS price_kopecks integer;
ALTER TABLE product_versions ADD COLUMN IF NOT EXISTS page jsonb;

-- Order: money and source. Revenue is possible only for a real payment.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','public'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS price_kopecks integer NOT NULL DEFAULT 0 CHECK (price_kopecks >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_test_payment boolean NOT NULL DEFAULT true;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS revenue_kopecks integer NOT NULL DEFAULT 0 CHECK (revenue_kopecks >= 0);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_revenue_requires_real_payment;
ALTER TABLE orders ADD CONSTRAINT orders_revenue_requires_real_payment
  CHECK (revenue_kopecks = 0 OR is_test_payment = false);
