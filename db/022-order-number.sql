-- Short order number people can read out loud: «Заказ №1042». One sequence for owner and
-- public orders. Existing orders are numbered by creation time. Additive and safe to re-run.
CREATE SEQUENCE IF NOT EXISTS order_number_sequence START 1001;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS number bigint;

WITH numbered AS (
  SELECT id, 1000 + row_number() OVER (ORDER BY created_at, id) AS n
  FROM orders WHERE number IS NULL
)
UPDATE orders o
SET number = numbered.n + COALESCE((SELECT max(number) - 1000 FROM orders), 0)
FROM numbered WHERE o.id = numbered.id;

SELECT setval('order_number_sequence', GREATEST(1000, COALESCE((SELECT max(number) FROM orders), 1000)));
ALTER SEQUENCE order_number_sequence OWNED BY orders.number;
ALTER TABLE orders ALTER COLUMN number SET DEFAULT nextval('order_number_sequence');
ALTER TABLE orders ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_number ON orders(number);
