-- Remet la base dans l'état initial entre deux benchs.
TRUNCATE stock_movements RESTART IDENTITY;
DELETE FROM products WHERE id > 10000;
UPDATE products SET quantity = 1000, updated_at = now();
SELECT setval('products_id_seq', 10000);
VACUUM ANALYZE;
