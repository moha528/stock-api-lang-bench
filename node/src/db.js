// Accès données : les requêtes exactes de SPEC.md, toutes en requêtes préparées
// (protocole étendu, statement nommé mis en cache par connexion).

const LIST_PRODUCTS =
  'SELECT id, sku, name, quantity, price_cents FROM products ORDER BY id LIMIT $1 OFFSET $2';

const GET_PRODUCT =
  'SELECT id, sku, name, quantity, price_cents FROM products WHERE id = $1';

const CREATE_PRODUCT =
  'INSERT INTO products (sku, name, quantity, price_cents) VALUES ($1, $2, $3, $4) ON CONFLICT (sku) DO NOTHING RETURNING id, sku, name, quantity, price_cents';

const APPLY_MOVEMENT = `WITH upd AS (
  UPDATE products SET quantity = quantity + $2, updated_at = now()
  WHERE id = $1 AND quantity + $2 >= 0
  RETURNING id, quantity
), ins AS (
  INSERT INTO stock_movements (product_id, delta, reason)
  SELECT id, $2, $3 FROM upd
  RETURNING id
)
SELECT upd.quantity, ins.id FROM upd, ins`;

const PRODUCT_EXISTS = 'SELECT 1 FROM products WHERE id = $1';

const STATS =
  'SELECT count(*)::bigint, coalesce(sum(quantity), 0)::bigint, coalesce(sum(quantity::bigint * price_cents), 0)::bigint FROM products';

// simple: false force le protocole étendu (donc préparé) même sans paramètre.
const PREPARED = { prepare: true, simple: false };

export function createDb(sql) {
  return {
    listProducts: (limit, offset) => sql.unsafe(LIST_PRODUCTS, [limit, offset], PREPARED),

    async getProduct(id) {
      const rows = await sql.unsafe(GET_PRODUCT, [id], PREPARED);
      return rows.length ? rows[0] : null;
    },

    async createProduct(sku, name, quantity, priceCents) {
      const rows = await sql.unsafe(CREATE_PRODUCT, [sku, name, quantity, priceCents], PREPARED);
      return rows.length ? rows[0] : null;
    },

    // Renvoie { quantity, id } si le mouvement est appliqué, sinon null.
    async applyMovement(id, delta, reason) {
      const rows = await sql.unsafe(APPLY_MOVEMENT, [id, delta, reason], PREPARED);
      return rows.length ? rows[0] : null;
    },

    async productExists(id) {
      const rows = await sql.unsafe(PRODUCT_EXISTS, [id], PREPARED);
      return rows.length > 0;
    },

    // Colonnes anonymes (count, coalesce, coalesce) : lecture positionnelle.
    async stats() {
      const rows = await sql.unsafe(STATS, [], PREPARED).values();
      return rows[0];
    },
  };
}
