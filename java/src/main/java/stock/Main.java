package stock;

import io.vertx.core.DeploymentOptions;
import io.vertx.core.Future;
import io.vertx.core.Vertx;
import io.vertx.core.VertxOptions;
import io.vertx.core.http.HttpClient;
import io.vertx.core.http.HttpClientResponse;
import io.vertx.core.http.HttpMethod;
import io.vertx.pgclient.PgBuilder;
import io.vertx.pgclient.PgConnectOptions;
import io.vertx.sqlclient.PoolOptions;
import io.vertx.sqlclient.SqlClient;

import java.util.concurrent.TimeUnit;

/** Point d'entrée : lit la config, crée Vert.x, le pool Postgres et démarre le serveur HTTP. */
public final class Main {

  public static void main(String[] args) throws Exception {
    int port = intEnv("PORT", 8080);
    String databaseUrl = env("DATABASE_URL", "postgres://stock:stock@db:5432/stock");
    int poolMax = intEnv("DB_POOL_MAX", 20);
    // Une boucle d'événements par vCPU (1 dans le conteneur cible) : pas de changement de contexte.
    int eventLoops = Runtime.getRuntime().availableProcessors();

    Vertx vertx = Vertx.vertx(new VertxOptions()
        .setEventLoopPoolSize(eventLoops)
        .setPreferNativeTransport(true)
        .setDisableTCCL(true));

    PgConnectOptions connect = PgConnectOptions.fromUri(databaseUrl)
        .setCachePreparedStatements(true)
        .setPreparedStatementCacheMaxSize(64)
        .setPipeliningLimit(intEnv("PG_PIPELINING_LIMIT", 16));

    // Client "pipeliné" : jusqu'à DB_POOL_MAX connexions, plusieurs requêtes en vol par connexion.
    // Le pool remplit une connexion jusqu'à la limite avant d'en ouvrir une autre : une limite haute
    // (256) concentre toute la charge sur un seul backend Postgres, mono-thread, qui devient le goulot.
    SqlClient client = PgBuilder.client()
        .with(new PoolOptions().setMaxSize(poolMax))
        .connectingTo(connect)
        .using(vertx)
        .build();

    Db db = new Db(client);

    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
      try {
        // Ferme le serveur HTTP (Api.stop, arrêt gracieux) puis le pool et les boucles d'événements.
        vertx.close().await(15, TimeUnit.SECONDS);
      } catch (Throwable ignored) {
        // arrêt en cours : rien à faire de plus
      }
    }, "shutdown"));

    try {
      vertx.deployVerticle(() -> new Api(db, port), new DeploymentOptions().setInstances(eventLoops))
          .await(30, TimeUnit.SECONDS);
    } catch (Throwable e) {
      System.err.println("startup failed: " + e);
      System.exit(1);
    }

    System.out.println("java/vertx listening on :" + port
        + " (event loops=" + eventLoops
        + ", native transport=" + vertx.isNativeTransportEnabled()
        + ", pool max=" + poolMax + ")");

    if (System.getenv("AOT_TRAINING") != null) {
      train(vertx, port);
      System.exit(0);
    }
  }

  /**
   * Exécution d'entraînement pour le cache AOT (JDK 25, JEP 483/515), lancée pendant le build de
   * l'image : charge et profile les chemins HTTP et JSON qui ne touchent pas la base.
   */
  private static void train(Vertx vertx, int port) throws Exception {
    HttpClient http = vertx.createHttpClient();
    String[][] calls = {
        {"GET", "/health", null},
        {"GET", "/products/abc", null},
        {"GET", "/products?limit=0", null},
        {"GET", "/nope", null},
        {"POST", "/products", "{not json"},
        {"POST", "/products", "{\"sku\":\"\",\"name\":\"x\",\"quantity\":1,\"price_cents\":1}"},
        {"POST", "/products/1/movements", "{\"delta\":0,\"reason\":\"x\"}"},
    };
    for (int i = 0; i < 2000; i++) {
      String[] c = calls[i % calls.length];
      http.request(HttpMethod.valueOf(c[0]), port, "localhost", c[1])
          .compose(req -> c[2] == null ? req.send() : req.send(c[2]))
          .compose(HttpClientResponse::body)
          .await(5, TimeUnit.SECONDS);
    }
    http.close().await(5, TimeUnit.SECONDS);
  }

  private static String env(String name, String def) {
    String v = System.getenv(name);
    return v == null || v.isEmpty() ? def : v;
  }

  private static int intEnv(String name, int def) {
    return Integer.parseInt(env(name, Integer.toString(def)));
  }

  private Main() {}
}
