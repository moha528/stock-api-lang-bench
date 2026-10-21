package stock;

import io.vertx.core.Future;
import io.vertx.core.json.JsonArray;
import io.vertx.core.json.JsonObject;
import io.vertx.sqlclient.PreparedQuery;
import io.vertx.sqlclient.Row;
import io.vertx.sqlclient.RowIterator;
import io.vertx.sqlclient.RowSet;
import io.vertx.sqlclient.SqlClient;
import io.vertx.sqlclient.Tuple;

/** Accès aux données : les requêtes de SPEC.md, en requêtes préparées (mises en cache par connexion). */
final class Db {

  static final String LIST_PRODUCTS =
      "SELECT id, sku, name, quantity, price_cents FROM products ORDER BY id LIMIT $1 OFFSET $2";
  static final String GET_PRODUCT =
      "SELECT id, sku, name, quantity, price_cents FROM products WHERE id = $1";
  static final String CREATE_PRODUCT =
      "INSERT INTO products (sku, name, quantity, price_cents) VALUES ($1, $2, $3, $4) "
          + "ON CONFLICT (sku) DO NOTHING RETURNING id, sku, name, quantity, price_cents";
  static final String MOVE_STOCK =
      "WITH upd AS (\n"
          + "  UPDATE products SET quantity = quantity + $2, updated_at = now()\n"
          + "  WHERE id = $1 AND quantity + $2 >= 0\n"
          + "  RETURNING id, quantity\n"
          + "), ins AS (\n"
          + "  INSERT INTO stock_movements (product_id, delta, reason)\n"
          + "  SELECT id, $2, $3 FROM upd\n"
          + "  RETURNING id\n"
          + ")\n"
          + "SELECT upd.quantity, ins.id FROM upd, ins";
  static final String PRODUCT_EXISTS = "SELECT 1 FROM products WHERE id = $1";
  static final String STATS =
      "SELECT count(*)::bigint, coalesce(sum(quantity), 0)::bigint, "
          + "coalesce(sum(quantity::bigint * price_cents), 0)::bigint FROM products";

  /** Résultat d'un mouvement : la ligne mise à jour, ou la raison de l'échec. */
  enum MoveStatus { OK, NOT_FOUND, INSUFFICIENT_STOCK }

  record Move(MoveStatus status, JsonObject body) {}

  private static final Move NOT_FOUND = new Move(MoveStatus.NOT_FOUND, null);
  private static final Move INSUFFICIENT = new Move(MoveStatus.INSUFFICIENT_STOCK, null);

  private final PreparedQuery<RowSet<Row>> listProducts;
  private final PreparedQuery<RowSet<Row>> getProduct;
  private final PreparedQuery<RowSet<Row>> createProduct;
  private final PreparedQuery<RowSet<Row>> moveStock;
  private final PreparedQuery<RowSet<Row>> productExists;
  private final PreparedQuery<RowSet<Row>> stats;

  Db(SqlClient client) {
    listProducts = client.preparedQuery(LIST_PRODUCTS);
    getProduct = client.preparedQuery(GET_PRODUCT);
    createProduct = client.preparedQuery(CREATE_PRODUCT);
    moveStock = client.preparedQuery(MOVE_STOCK);
    productExists = client.preparedQuery(PRODUCT_EXISTS);
    stats = client.preparedQuery(STATS);
  }

  Future<JsonArray> listProducts(long limit, long offset) {
    return listProducts.execute(Tuple.of(limit, offset)).map(rows -> {
      JsonArray out = new JsonArray(new java.util.ArrayList<>(rows.size()));
      for (Row row : rows) {
        out.add(product(row));
      }
      return out;
    });
  }

  /** Le produit, ou {@code null} s'il n'existe pas. */
  Future<JsonObject> getProduct(long id) {
    return getProduct.execute(Tuple.of(id)).map(Db::firstProduct);
  }

  /** Le produit créé, ou {@code null} si le SKU est déjà pris. */
  Future<JsonObject> createProduct(String sku, String name, int quantity, long priceCents) {
    return createProduct.execute(Tuple.of(sku, name, quantity, priceCents)).map(Db::firstProduct);
  }

  Future<Move> moveStock(long id, int delta, String reason) {
    return moveStock.execute(Tuple.of(id, delta, reason)).compose(rows -> {
      RowIterator<Row> it = rows.iterator();
      if (it.hasNext()) {
        Row row = it.next();
        return Future.succeededFuture(new Move(MoveStatus.OK, new JsonObject()
            .put("product_id", id)
            .put("quantity", row.getInteger(0))
            .put("movement_id", row.getLong(1))));
      }
      return productExists.execute(Tuple.of(id))
          .map(found -> found.size() == 0 ? NOT_FOUND : INSUFFICIENT);
    });
  }

  Future<JsonObject> stats() {
    return stats.execute().map(rows -> {
      Row row = rows.iterator().next();
      return new JsonObject()
          .put("products", row.getLong(0))
          .put("total_quantity", row.getLong(1))
          .put("total_value_cents", row.getLong(2));
    });
  }

  private static JsonObject firstProduct(RowSet<Row> rows) {
    RowIterator<Row> it = rows.iterator();
    return it.hasNext() ? product(it.next()) : null;
  }

  private static JsonObject product(Row row) {
    return new JsonObject()
        .put("id", row.getLong(0))
        .put("sku", row.getString(1))
        .put("name", row.getString(2))
        .put("quantity", row.getInteger(3))
        .put("price_cents", row.getLong(4));
  }
}
