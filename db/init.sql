CREATE TABLE products (
  id          BIGSERIAL PRIMARY KEY,
  sku         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stock_movements (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX stock_movements_product_id_idx ON stock_movements (product_id);

INSERT INTO products (sku, name, quantity, price_cents)
SELECT 'SKU-' || lpad(i::text, 6, '0'), 'Product ' || i, 1000, (i * 37) % 10000 + 100
FROM generate_series(1, 10000) AS i;
