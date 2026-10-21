//! Accès aux données : les requêtes de SPEC.md, en requêtes préparées mises en cache par connexion.

use deadpool_postgres::{Pool, PoolError};
use serde::ser::{Serialize, SerializeStruct, Serializer};
use tokio_postgres::{Row, types::Type};

const SQL_LIST: &str =
    "SELECT id, sku, name, quantity, price_cents FROM products ORDER BY id LIMIT $1 OFFSET $2";
const SQL_GET: &str = "SELECT id, sku, name, quantity, price_cents FROM products WHERE id = $1";
const SQL_CREATE: &str = "INSERT INTO products (sku, name, quantity, price_cents) VALUES ($1, $2, $3, $4) ON CONFLICT (sku) DO NOTHING RETURNING id, sku, name, quantity, price_cents";
const SQL_MOVEMENT: &str = "WITH upd AS (
    UPDATE products SET quantity = quantity + $2, updated_at = now()
    WHERE id = $1 AND quantity + $2 >= 0
    RETURNING id, quantity
  ), ins AS (
    INSERT INTO stock_movements (product_id, delta, reason)
    SELECT id, $2, $3 FROM upd
    RETURNING id
  )
  SELECT upd.quantity, ins.id FROM upd, ins";
const SQL_EXISTS: &str = "SELECT 1 FROM products WHERE id = $1";
const SQL_STATS: &str = "SELECT count(*)::bigint, coalesce(sum(quantity), 0)::bigint, coalesce(sum(quantity::bigint * price_cents), 0)::bigint FROM products";

/// Erreur d'infrastructure (pool ou Postgres) : toujours traduite en 500.
pub struct DbError;

impl From<PoolError> for DbError {
    fn from(_: PoolError) -> Self {
        DbError
    }
}

impl From<tokio_postgres::Error> for DbError {
    fn from(_: tokio_postgres::Error) -> Self {
        DbError
    }
}

pub type DbResult<T> = Result<T, DbError>;

pub enum Movement {
    Applied { quantity: i32, movement_id: i64 },
    NotFound,
    InsufficientStock,
}

#[derive(serde::Serialize)]
pub struct Stats {
    pub products: i64,
    pub total_quantity: i64,
    pub total_value_cents: i64,
}

pub async fn list_products(pool: &Pool, limit: i64, offset: i64) -> DbResult<Vec<Row>> {
    let client = pool.get().await?;
    let stmt = client.prepare_typed_cached(SQL_LIST, &[Type::INT8, Type::INT8]).await?;
    Ok(client.query(&stmt, &[&limit, &offset]).await?)
}

pub async fn get_product(pool: &Pool, id: i64) -> DbResult<Option<Row>> {
    let client = pool.get().await?;
    let stmt = client.prepare_typed_cached(SQL_GET, &[Type::INT8]).await?;
    Ok(client.query_opt(&stmt, &[&id]).await?)
}

/// `None` si le SKU existe déjà (ON CONFLICT DO NOTHING ne renvoie aucune ligne).
pub async fn create_product(
    pool: &Pool,
    sku: &str,
    name: &str,
    quantity: i32,
    price_cents: i64,
) -> DbResult<Option<Row>> {
    let client = pool.get().await?;
    let stmt = client
        .prepare_typed_cached(SQL_CREATE, &[Type::TEXT, Type::TEXT, Type::INT4, Type::INT8])
        .await?;
    Ok(client.query_opt(&stmt, &[&sku, &name, &quantity, &price_cents]).await?)
}

pub async fn apply_movement(pool: &Pool, id: i64, delta: i32, reason: &str) -> DbResult<Movement> {
    let client = pool.get().await?;
    let stmt = client
        .prepare_typed_cached(SQL_MOVEMENT, &[Type::INT8, Type::INT4, Type::TEXT])
        .await?;
    if let Some(row) = client.query_opt(&stmt, &[&id, &delta, &reason]).await? {
        return Ok(Movement::Applied { quantity: row.get(0), movement_id: row.get(1) });
    }
    let stmt = client.prepare_typed_cached(SQL_EXISTS, &[Type::INT8]).await?;
    Ok(match client.query_opt(&stmt, &[&id]).await? {
        None => Movement::NotFound,
        Some(_) => Movement::InsufficientStock,
    })
}

pub async fn stats(pool: &Pool) -> DbResult<Stats> {
    let client = pool.get().await?;
    let stmt = client.prepare_typed_cached(SQL_STATS, &[]).await?;
    let row = client.query_one(&stmt, &[]).await?;
    Ok(Stats { products: row.get(0), total_quantity: row.get(1), total_value_cents: row.get(2) })
}

/// Sérialise une ligne produit directement depuis le buffer du driver, sans allouer de String.
pub struct ProductJson<'a>(pub &'a Row);

impl Serialize for ProductJson<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let r = self.0;
        let mut st = s.serialize_struct("Product", 5)?;
        st.serialize_field("id", &r.get::<_, i64>(0))?;
        st.serialize_field("sku", r.get::<_, &str>(1))?;
        st.serialize_field("name", r.get::<_, &str>(2))?;
        st.serialize_field("quantity", &r.get::<_, i32>(3))?;
        st.serialize_field("price_cents", &r.get::<_, i64>(4))?;
        st.end()
    }
}

pub struct ProductList<'a>(pub &'a [Row]);

impl Serialize for ProductList<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.0.iter().map(ProductJson))
    }
}
