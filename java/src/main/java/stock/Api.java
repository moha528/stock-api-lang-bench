package stock;

import io.vertx.core.Future;
import io.vertx.core.Handler;
import io.vertx.core.VerticleBase;
import io.vertx.core.buffer.Buffer;
import io.vertx.core.http.HttpHeaders;
import io.vertx.core.http.HttpMethod;
import io.vertx.core.http.HttpServer;
import io.vertx.core.http.HttpServerOptions;
import io.vertx.core.http.HttpServerRequest;
import io.vertx.core.json.DecodeException;
import io.vertx.core.json.Json;
import io.vertx.core.json.JsonObject;

import java.util.concurrent.TimeUnit;

/** Routage HTTP et validation des entrées, sans framework (vertx-core seul). */
final class Api extends VerticleBase implements Handler<HttpServerRequest> {

  private static final CharSequence CONTENT_TYPE = HttpHeaders.CONTENT_TYPE;
  private static final CharSequence APPLICATION_JSON = HttpHeaders.createOptimized("application/json");

  private static final Buffer HEALTH = Buffer.buffer("{\"status\":\"ok\"}");
  private static final Buffer INVALID_INPUT = Buffer.buffer("{\"error\":\"invalid_input\"}");
  private static final Buffer NOT_FOUND = Buffer.buffer("{\"error\":\"not_found\"}");
  private static final Buffer CONFLICT = Buffer.buffer("{\"error\":\"conflict\"}");
  private static final Buffer INSUFFICIENT_STOCK = Buffer.buffer("{\"error\":\"insufficient_stock\"}");
  private static final Buffer INTERNAL = Buffer.buffer("{\"error\":\"internal\"}");

  private static final String PRODUCTS = "/products";
  private static final String PRODUCTS_PREFIX = "/products/";
  private static final String MOVEMENTS_SUFFIX = "/movements";

  private final Db db;
  private final int port;
  private HttpServer server;

  Api(Db db, int port) {
    this.db = db;
    this.port = port;
  }

  @Override
  public Future<?> start() {
    server = vertx.createHttpServer(new HttpServerOptions()
            .setHttp2ClearTextEnabled(false)
            .setTcpNoDelay(true)
            .setTcpFastOpen(true)
            .setTcpQuickAck(true))
        .requestHandler(this);
    return server.listen(port, "0.0.0.0");
  }

  @Override
  public Future<?> stop() {
    // Arrêt gracieux : plus de nouvelles connexions, les requêtes en cours se terminent.
    return server.shutdown(5, TimeUnit.SECONDS);
  }

  @Override
  public void handle(HttpServerRequest req) {
    try {
      route(req);
    } catch (RuntimeException e) {
      send(req, 500, INTERNAL);
    }
  }

  private void route(HttpServerRequest req) {
    String path = req.path();
    HttpMethod method = req.method();
    switch (path) {
      case "/health" -> {
        if (method == HttpMethod.GET) send(req, 200, HEALTH);
        else send(req, 404, NOT_FOUND);
      }
      case "/stats" -> {
        if (method == HttpMethod.GET) stats(req);
        else send(req, 404, NOT_FOUND);
      }
      case PRODUCTS -> {
        if (method == HttpMethod.GET) listProducts(req);
        else if (method == HttpMethod.POST) createProduct(req);
        else send(req, 404, NOT_FOUND);
      }
      default -> {
        if (!path.startsWith(PRODUCTS_PREFIX)) {
          send(req, 404, NOT_FOUND);
          return;
        }
        String rest = path.substring(PRODUCTS_PREFIX.length());
        int slash = rest.indexOf('/');
        if (slash < 0 && !rest.isEmpty() && method == HttpMethod.GET) {
          getProduct(req, rest);
        } else if (slash > 0 && method == HttpMethod.POST
            && rest.length() - slash == MOVEMENTS_SUFFIX.length() && rest.endsWith(MOVEMENTS_SUFFIX)) {
          moveStock(req, rest.substring(0, slash));
        } else {
          send(req, 404, NOT_FOUND);
        }
      }
    }
  }

  // ---- handlers ----

  private void listProducts(HttpServerRequest req) {
    long limit;
    long offset;
    try {
      limit = queryParam(req, "limit", 50);
      offset = queryParam(req, "offset", 0);
    } catch (IllegalArgumentException e) {
      send(req, 400, INVALID_INPUT);
      return;
    }
    if (limit < 1 || limit > 100 || offset < 0) {
      send(req, 400, INVALID_INPUT);
      return;
    }
    db.listProducts(limit, offset).onComplete(ar -> {
      if (ar.succeeded()) send(req, 200, ar.result().toBuffer());
      else send(req, 500, INTERNAL);
    });
  }

  private void getProduct(HttpServerRequest req, String rawId) {
    long id = parseId(rawId);
    if (id <= 0) {
      send(req, 400, INVALID_INPUT);
      return;
    }
    db.getProduct(id).onComplete(ar -> {
      if (ar.failed()) send(req, 500, INTERNAL);
      else if (ar.result() == null) send(req, 404, NOT_FOUND);
      else send(req, 200, ar.result().toBuffer());
    });
  }

  private void createProduct(HttpServerRequest req) {
    req.body().onSuccess(body -> {
      JsonObject in = parseObject(body);
      String sku = in == null ? null : string(in.getValue("sku"), 64);
      String name = in == null ? null : string(in.getValue("name"), 200);
      long quantity = in == null ? -1 : integer(in.getValue("quantity"));
      long priceCents = in == null ? -1 : integer(in.getValue("price_cents"));
      // quantity est une colonne INTEGER : au-delà de 2^31-1 la valeur est refusée en 400.
      if (sku == null || name == null || quantity < 0 || quantity > Integer.MAX_VALUE || priceCents < 0) {
        send(req, 400, INVALID_INPUT);
        return;
      }
      db.createProduct(sku, name, (int) quantity, priceCents).onComplete(ar -> {
        if (ar.failed()) send(req, 500, INTERNAL);
        else if (ar.result() == null) send(req, 409, CONFLICT);
        else send(req, 201, ar.result().toBuffer());
      });
    });
  }

  private void moveStock(HttpServerRequest req, String rawId) {
    long id = parseId(rawId);
    req.body().onSuccess(body -> {
      if (id <= 0) {
        send(req, 400, INVALID_INPUT);
        return;
      }
      JsonObject in = parseObject(body);
      Object rawDelta = in == null ? null : in.getValue("delta");
      long delta = isInteger(rawDelta) ? ((Number) rawDelta).longValue() : 0;
      String reason = in == null ? null : string(in.getValue("reason"), 100);
      if (delta == 0 || delta < -1_000_000 || delta > 1_000_000 || reason == null) {
        send(req, 400, INVALID_INPUT);
        return;
      }
      db.moveStock(id, (int) delta, reason).onComplete(ar -> {
        if (ar.failed()) {
          send(req, 500, INTERNAL);
          return;
        }
        Db.Move move = ar.result();
        switch (move.status()) {
          case OK -> send(req, 200, move.body().toBuffer());
          case NOT_FOUND -> send(req, 404, NOT_FOUND);
          case INSUFFICIENT_STOCK -> send(req, 409, INSUFFICIENT_STOCK);
        }
      });
    });
  }

  private void stats(HttpServerRequest req) {
    db.stats().onComplete(ar -> {
      if (ar.succeeded()) send(req, 200, ar.result().toBuffer());
      else send(req, 500, INTERNAL);
    });
  }

  // ---- helpers ----

  private static void send(HttpServerRequest req, int status, Buffer body) {
    req.response()
        .setStatusCode(status)
        .putHeader(CONTENT_TYPE, APPLICATION_JSON)
        .end(body);
  }

  /** Paramètre de requête entier ; absent : valeur par défaut ; invalide : IllegalArgumentException. */
  private static long queryParam(HttpServerRequest req, String name, long def) {
    String v = req.getParam(name);
    return v == null ? def : Long.parseLong(v);
  }

  /** Identifiant int64 > 0, ou -1 si invalide. */
  private static long parseId(String s) {
    try {
      long v = Long.parseLong(s);
      return v > 0 ? v : -1;
    } catch (NumberFormatException e) {
      return -1;
    }
  }

  /** Corps JSON s'il s'agit d'un objet, sinon {@code null}. */
  private static JsonObject parseObject(Buffer body) {
    try {
      return Json.decodeValue(body) instanceof JsonObject o ? o : null;
    } catch (DecodeException e) {
      return null;
    }
  }

  /** Chaîne de 1 à {@code max} caractères, sinon {@code null}. */
  private static String string(Object v, int max) {
    return v instanceof String s && !s.isEmpty() && s.length() <= max ? s : null;
  }

  /** Nombre JSON entier (pas de décimales, tient dans un int64). */
  private static boolean isInteger(Object v) {
    return v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte;
  }

  /** Entier JSON tenant dans un int64, sinon -1 (refusé par les contrôles >= 0). */
  private static long integer(Object v) {
    return isInteger(v) ? ((Number) v).longValue() : -1;
  }
}
