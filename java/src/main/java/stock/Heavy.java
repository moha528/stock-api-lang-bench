package stock;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import io.netty.buffer.Unpooled;
import io.vertx.core.Vertx;
import io.vertx.core.WorkerExecutor;
import io.vertx.core.buffer.Buffer;
import io.vertx.core.http.HttpHeaders;
import io.vertx.core.http.HttpMethod;
import io.vertx.core.http.HttpServerRequest;
import io.vertx.core.internal.buffer.BufferInternal;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.concurrent.Callable;
import java.util.concurrent.TimeUnit;

/**
 * Traitements lourds en CPU de SPEC-heavy.md ({@code /cpu/*}).
 *
 * <p>La boucle d'événements ne fait que valider les paramètres (et accumuler le corps pour
 * commissions) ; le calcul part sur un pool de workers de taille fixe = nombre de CPU, file non
 * bornée, et la réponse revient sur le contexte Vert.x de la requête.
 */
final class Heavy {

  static final String PREFIX = "/cpu/";

  private static final int MAX_BODY = 16 * 1024 * 1024;
  private static final long SEED_MAX = (1L << 53) - 1;

  /** Erreur de validation (400), sans pile : elle sert de signal, pas de diagnostic. */
  private static final class Invalid extends IllegalArgumentException {
    Invalid() {
      super("invalid_input");
      setStackTrace(new StackTraceElement[0]);
    }

    @Override
    public synchronized Throwable fillInStackTrace() {
      return this;
    }
  }

  private static final Invalid INVALID = new Invalid();

  private final WorkerExecutor workers;
  final int poolSize;

  Heavy(Vertx vertx) {
    poolSize = Runtime.getRuntime().availableProcessors();
    // Pool Vert.x dédié : ThreadPoolExecutor fixe, LinkedBlockingQueue non bornée. Temps max
    // d'exécution très large : un Monte-Carlo aux bornes de la spec dure plusieurs secondes.
    workers = vertx.createSharedWorkerExecutor("cpu-worker", poolSize, 1, TimeUnit.HOURS);
  }

  // ---- routage (boucle d'événements) ----

  void handle(HttpServerRequest req, String path) {
    boolean get = req.method() == HttpMethod.GET;
    try {
      switch (path) {
        case "/cpu/hash" -> {
          if (!get) break;
          int rounds = (int) param(req, "rounds", 200_000, 1, 5_000_000);
          long seed = param(req, "seed", 42, 0, SEED_MAX);
          run(req, () -> hash(rounds, seed));
          return;
        }
        case "/cpu/montecarlo" -> {
          if (!get) break;
          int paths = (int) param(req, "paths", 20_000, 1, 1_000_000);
          int steps = (int) param(req, "steps", 252, 1, 10_000);
          long seed = param(req, "seed", 42, 0, SEED_MAX);
          run(req, () -> monteCarlo(paths, steps, seed));
          return;
        }
        case "/cpu/reconcile" -> {
          if (!get) break;
          int n = (int) param(req, "n", 100_000, 1, 1_000_000);
          long seed = param(req, "seed", 42, 0, SEED_MAX);
          run(req, () -> reconcile(n, seed));
          return;
        }
        case "/cpu/sort" -> {
          if (!get) break;
          int n = (int) param(req, "n", 100_000, 1, 1_000_000);
          long seed = param(req, "seed", 42, 0, SEED_MAX);
          run(req, () -> sort(n, seed));
          return;
        }
        case "/cpu/commissions" -> {
          if (req.method() != HttpMethod.POST) break;
          commissions(req);
          return;
        }
        default -> {
        }
      }
    } catch (IllegalArgumentException e) { // Invalid ou NumberFormatException
      Api.send(req, 400, Api.INVALID_INPUT);
      return;
    }
    Api.send(req, 404, Api.NOT_FOUND);
  }

  /** Paramètre entier dans [min, max] ; absent : défaut ; sinon {@link IllegalArgumentException}. */
  private static long param(HttpServerRequest req, String name, long def, long min, long max) {
    String v = req.getParam(name);
    if (v == null) return def;
    long x = Long.parseLong(v);
    if (x < min || x > max) throw INVALID;
    return x;
  }

  private void run(HttpServerRequest req, Callable<Buffer> task) {
    workers.executeBlocking(task, false).onComplete(ar -> {
      try {
        if (ar.succeeded()) Api.send(req, 200, ar.result());
        else if (ar.cause() instanceof Invalid) Api.send(req, 400, Api.INVALID_INPUT);
        else Api.send(req, 500, Api.INTERNAL);
      } catch (RuntimeException ignored) {
        // client parti entre-temps
      }
    });
  }

  /** Accumule le corps (16 Mo max) dans un tableau pré-dimensionné, puis calcule sur un worker. */
  private void commissions(HttpServerRequest req) {
    String cl = req.getHeader(HttpHeaders.CONTENT_LENGTH);
    long declared = cl == null ? -1 : Long.parseLong(cl);
    if (declared > MAX_BODY) {
      rejectAndClose(req);
      return;
    }
    Body body = new Body(declared >= 0 ? (int) declared : 64 * 1024);
    req.handler(chunk -> {
      if (body.rejected) return;
      if (!body.append(chunk)) {
        body.rejected = true;
        rejectAndClose(req);
      }
    });
    req.endHandler(v -> {
      if (!body.rejected) run(req, () -> commissions(body.data, body.len));
    });
  }

  private static void rejectAndClose(HttpServerRequest req) {
    req.response()
        .setStatusCode(400)
        .putHeader(HttpHeaders.CONTENT_TYPE, Api.APPLICATION_JSON)
        .putHeader(HttpHeaders.CONNECTION, "close")
        .end(Api.INVALID_INPUT)
        .onComplete(ar -> req.connection().close());
  }

  private static final class Body {
    byte[] data;
    int len;
    boolean rejected;

    Body(int capacity) {
      data = new byte[Math.max(capacity, 1)];
    }

    boolean append(Buffer chunk) {
      int n = chunk.length();
      if ((long) len + n > MAX_BODY) return false;
      if (len + n > data.length) data = Arrays.copyOf(data, Math.min(MAX_BODY, Math.max(len + n, data.length * 2)));
      chunk.getBytes(0, n, data, len);
      len += n;
      return true;
    }
  }

  // ---- splitmix64 ----

  private static final long GOLDEN = 0x9E3779B97F4A7C15L;

  /** Sortie de splitmix64 pour l'état déjà incrémenté. L'état reste une variable locale de l'appelant. */
  private static long mix(long z) {
    z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9L;
    z = (z ^ (z >>> 27)) * 0x94D049BB133111EBL;
    return z ^ (z >>> 31);
  }

  // ---- 1. hash ----

  private static final ThreadLocal<MessageDigest> SHA256 = ThreadLocal.withInitial(() -> {
    try {
      return MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  });

  /** SHA-256 itéré. MessageDigest SUN : implCompress est un intrinsèque HotSpot (SHA-NI ou AVX2). */
  static Buffer hash(int rounds, long seed) throws Exception {
    MessageDigest md = SHA256.get();
    byte[] h = new byte[32];
    byte[] s = new byte[8];
    for (int i = 0; i < 8; i++) s[i] = (byte) (seed >>> (56 - 8 * i));
    md.reset();
    md.update(s);
    md.digest(h, 0, 32);
    for (int i = 1; i < rounds; i++) {
      md.update(h, 0, 32);
      md.digest(h, 0, 32); // écrit dans h, sans allocation ; digest() réinitialise
    }
    JsonOut out = new JsonOut(80);
    out.raw("{\"digest\":\"");
    for (byte b : h) {
      out.ascii(HEX[(b >>> 4) & 15]);
      out.ascii(HEX[b & 15]);
    }
    return out.raw("\"}").toBuffer();
  }

  // ---- 2. Monte-Carlo ----

  /** Doubles IEEE 754 dans l'ordre exact de la spec : pas de FMA (C2 n'en génère pas seul), somme séquentielle. */
  static Buffer monteCarlo(int paths, int steps, long seed) {
    final double s0 = 100.0, k = 100.0, mu = 0.05, sigma = 0.2, sqrt3 = 1.7320508075688772;
    final double dt = 1.0 / steps, sqrtDt = Math.sqrt(dt), drift = mu * dt, vol = sigma * sqrtDt;
    final double base = 1.0 + drift; // (1.0 + drift) + vol * z : même association que la spec
    long state = seed;
    double sum = 0.0;
    for (int p = 0; p < paths; p++) {
      double s = s0;
      for (int t = 0; t < steps; t++) {
        state += GOLDEN;
        double u = (mix(state) >>> 11) * 0x1.0p-53;
        double z = (2.0 * u - 1.0) * sqrt3;
        s = s * (base + vol * z);
      }
      sum += Math.max(s - k, 0.0);
    }
    JsonOut out = new JsonOut(96);
    out.raw("{\"price\":").dbl(sum / paths);
    out.raw(",\"paths\":").num(paths);
    out.raw(",\"steps\":").num(steps);
    return out.raw("}").toBuffer();
  }

  // ---- 3. reconcile ----

  static Buffer reconcile(int n, long seed) {
    long state = seed;
    byte[] scratch = new byte[20];
    scratch[0] = 'P';
    scratch[1] = 'A';
    scratch[2] = 'Y';
    scratch[3] = '-';

    String[] payRef = new String[n];
    int[] payAmount = new int[n];
    for (int i = 0; i < n; i++) {
      state += GOLDEN;
      payRef[i] = ref(scratch, mix(state));
      state += GOLDEN;
      payAmount[i] = 100 + (int) Long.remainderUnsigned(mix(state), 1_000_000);
    }

    int unknown = n / 50;
    String[] bankRef = new String[n + unknown];
    int[] bankAmount = new int[n + unknown];
    int len = 0;
    for (int i = 0; i < n; i++) {
      state += GOLDEN;
      long x = Long.remainderUnsigned(mix(state), 100);
      if (x < 5) continue;
      int amount = payAmount[i];
      if (x < 10) {
        state += GOLDEN;
        amount += 1 + (int) Long.remainderUnsigned(mix(state), 500);
      }
      bankRef[len] = payRef[i];
      bankAmount[len] = amount;
      len++;
    }
    for (int i = 0; i < unknown; i++) {
      state += GOLDEN;
      bankRef[len] = ref(scratch, mix(state));
      state += GOLDEN;
      bankAmount[len] = 100 + (int) Long.remainderUnsigned(mix(state), 1_000_000);
      len++;
    }

    for (int i = len - 1; i >= 1; i--) { // Fisher–Yates
      state += GOLDEN;
      int j = (int) Long.remainderUnsigned(mix(state), i + 1);
      String r = bankRef[i];
      bankRef[i] = bankRef[j];
      bankRef[j] = r;
      int a = bankAmount[i];
      bankAmount[i] = bankAmount[j];
      bankAmount[j] = a;
    }

    RefTable table = new RefTable(n);
    for (int i = 0; i < n; i++) table.put(payRef[i], payAmount[i]);

    long matched = 0, mismatched = 0, unknownCount = 0, matchedCents = 0;
    for (int i = 0; i < len; i++) {
      int expected = table.get(bankRef[i]);
      if (expected == RefTable.MISSING) unknownCount++;
      else if (expected == bankAmount[i]) {
        matched++;
        matchedCents += expected;
      } else mismatched++;
    }

    JsonOut out = new JsonOut(160);
    out.raw("{\"matched\":").num(matched);
    out.raw(",\"mismatched\":").num(mismatched);
    out.raw(",\"missing\":").num(n - matched - mismatched);
    out.raw(",\"unknown\":").num(unknownCount);
    out.raw(",\"matched_cents\":").num(matchedCents);
    return out.raw("}").toBuffer();
  }

  /** "PAY-" + 16 chiffres hex minuscules (zéros à gauche), String Latin-1 : une seule copie du tampon. */
  private static String ref(byte[] scratch, long v) {
    for (int i = 0; i < 16; i++) scratch[4 + i] = HEX[(int) (v >>> (60 - 4 * i)) & 15];
    return new String(scratch, 0, 20, StandardCharsets.ISO_8859_1);
  }

  /**
   * Table de hachage String → int à adressage ouvert (sondage linéaire), pré-dimensionnée à un
   * facteur de charge ≤ 0,5 : clés String (hashCode mis en cache dans la String, equals
   * intrinsèque), montants en int[] sans autoboxing ni nœud par entrée.
   */
  private static final class RefTable {
    static final int MISSING = Integer.MIN_VALUE;
    private final String[] keys;
    private final int[] values;
    private final int mask;
    private final int shift;

    RefTable(int expected) {
      int bits = 32 - Integer.numberOfLeadingZeros(Math.max(1, 2 * expected - 1));
      int cap = 1 << Math.max(bits, 1);
      keys = new String[cap];
      values = new int[cap];
      mask = cap - 1;
      shift = 32 - Integer.numberOfTrailingZeros(cap);
    }

    private int slot(String k) {
      return (k.hashCode() * 0x9E3779B9) >>> shift; // hachage de Fibonacci : bits de poids fort
    }

    void put(String k, int v) {
      int i = slot(k);
      String cur;
      while ((cur = keys[i]) != null && !cur.equals(k)) i = (i + 1) & mask;
      keys[i] = k; // ref dupliquée : la dernière l'emporte, comme new Map(payments)
      values[i] = v;
    }

    int get(String k) {
      int i = slot(k);
      String cur;
      while ((cur = keys[i]) != null) {
        if (cur.equals(k)) return values[i];
        i = (i + 1) & mask;
      }
      return MISSING;
    }
  }

  // ---- 4. sort ----

  private static final byte[] ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789".getBytes(StandardCharsets.ISO_8859_1);

  static Buffer sort(int n, long seed) {
    long state = seed;
    byte[] scratch = new byte[16];
    String[] xs = new String[n];
    for (int i = 0; i < n; i++) {
      for (int c = 0; c < 16; c++) {
        state += GOLDEN;
        scratch[c] = ALPHABET[(int) Long.remainderUnsigned(mix(state), 36)];
      }
      xs[i] = new String(scratch, 0, 16, StandardCharsets.ISO_8859_1);
    }
    // Strings Latin-1 : compareTo (intrinsèque vectorisé) = ordre des octets. TimSort séquentiel.
    Arrays.sort(xs);
    long h = 0xcbf29ce484222325L;
    for (String s : xs) {
      for (int c = 0, l = s.length(); c < l; c++) h = (h ^ s.charAt(c)) * 0x100000001b3L;
      h = (h ^ '\n') * 0x100000001b3L;
    }
    JsonOut out = new JsonOut(96);
    out.raw("{\"first\":").str(xs[0]);
    out.raw(",\"last\":").str(xs[n - 1]);
    out.raw(",\"fnv\":\"").hex16(h);
    return out.raw("\"}").toBuffer();
  }

  // ---- 5. commissions ----

  private static final JsonFactory JSON = new JsonFactory();
  private static final int MAX_LINES = 200_000;
  private static final int[] RATES = {800, 1000, 600, 1200}; // AUTO, HABITATION, SANTE, PREVOYANCE

  private static final class Agent {
    final String name;
    final int hash;
    int lines;
    long premium;
    long commission;

    Agent(String name, int hash) {
      this.name = name;
      this.hash = hash;
    }
  }

  private static final Comparator<Agent> BY_COMMISSION = (x, y) ->
      x.commission != y.commission ? Long.compare(y.commission, x.commission) : x.name.compareTo(y.name);

  /** Regroupement par agent sans String par ligne : l'agent est cherché sur les caractères du parseur. */
  private static final class Agents {
    Agent[] all = new Agent[64];
    int count;
    private int[] slots = new int[128]; // index + 1, 0 = libre
    private int mask = 127;

    int find(char[] c, int off, int len) {
      int h = 0;
      for (int i = 0; i < len; i++) h = 31 * h + c[off + i]; // même valeur que String.hashCode
      int i = (h * 0x9E3779B9) & mask;
      int s;
      while ((s = slots[i]) != 0) {
        Agent a = all[s - 1];
        if (a.hash == h && same(a.name, c, off, len)) return s - 1;
        i = (i + 1) & mask;
      }
      if (count == all.length) all = Arrays.copyOf(all, count * 2);
      all[count] = new Agent(new String(c, off, len), h);
      slots[i] = ++count;
      if (count * 2 > slots.length) grow();
      return count - 1;
    }

    private static boolean same(String s, char[] c, int off, int len) {
      if (s.length() != len) return false;
      for (int i = 0; i < len; i++) if (s.charAt(i) != c[off + i]) return false;
      return true;
    }

    private void grow() {
      slots = new int[slots.length * 2];
      mask = slots.length - 1;
      for (int k = 0; k < count; k++) {
        int i = (all[k].hash * 0x9E3779B9) & mask;
        while (slots[i] != 0) i = (i + 1) & mask;
        slots[i] = k + 1;
      }
    }
  }

  /** Lignes en tableaux primitifs parallèles, agrandis à la demande (200 000 au plus). */
  private static final class Lines {
    int[] agent;
    byte[] product;
    int[] premium;
    int count;

    Lines(int capacity) {
      agent = new int[capacity];
      product = new byte[capacity];
      premium = new int[capacity];
    }

    void add(int a, int p, int cents) {
      if (count == MAX_LINES) throw INVALID;
      if (count == agent.length) {
        int cap = Math.min(MAX_LINES, count * 2);
        agent = Arrays.copyOf(agent, cap);
        product = Arrays.copyOf(product, cap);
        premium = Arrays.copyOf(premium, cap);
      }
      agent[count] = a;
      product[count] = (byte) p;
      premium[count] = cents;
      count++;
    }
  }

  static Buffer commissions(byte[] data, int len) throws Exception {
    Agents agents = new Agents();
    Lines lines = null;
    try (JsonParser p = JSON.createParser(data, 0, len)) {
      if (p.nextToken() != JsonToken.START_OBJECT) throw INVALID;
      JsonToken t;
      while ((t = p.nextToken()) == JsonToken.FIELD_NAME) {
        String field = p.currentName();
        t = p.nextToken();
        if ("lines".equals(field)) {
          if (t != JsonToken.START_ARRAY) throw INVALID;
          agents = new Agents(); // clé dupliquée : la dernière l'emporte
          lines = new Lines(Math.max(16, Math.min(MAX_LINES, len / 48)));
          parseLines(p, agents, lines);
        } else {
          p.skipChildren();
        }
      }
      if (t != JsonToken.END_OBJECT || p.nextToken() != null) throw INVALID;
    } catch (Invalid e) {
      throw e;
    } catch (java.io.IOException | RuntimeException e) { // JSON invalide, nombre trop grand…
      throw INVALID;
    }
    if (lines == null || lines.count == 0) throw INVALID;

    // Agrégats, puis commission ligne à ligne (bonus connu une fois la somme de l'agent faite).
    Agent[] all = agents.all;
    int[] la = lines.agent;
    int[] lp = lines.premium;
    byte[] lprod = lines.product;
    int n = lines.count;
    for (int i = 0; i < n; i++) {
      Agent a = all[la[i]];
      a.lines++;
      a.premium += lp[i];
    }
    for (int i = 0; i < n; i++) {
      Agent a = all[la[i]];
      int rate = RATES[lprod[i]] + (a.premium >= 5_000_000 ? 100 : 0);
      a.commission += (long) lp[i] * rate / 10_000; // premium ≥ 0 : division entière = floor
    }
    int count = agents.count;
    long total = 0;
    for (int i = 0; i < count; i++) total += all[i].commission;
    Arrays.sort(all, 0, count, BY_COMMISSION);

    JsonOut out = new JsonOut(64 + count * 96);
    out.raw("{\"agents\":[");
    for (int i = 0; i < count; i++) {
      Agent a = all[i];
      if (i > 0) out.ascii((byte) ',');
      out.raw("{\"agent\":").str(a.name);
      out.raw(",\"lines\":").num(a.lines);
      out.raw(",\"premium_cents\":").num(a.premium);
      out.raw(",\"commission_cents\":").num(a.commission);
      out.ascii((byte) '}');
    }
    out.raw("],\"total_commission_cents\":").num(total);
    return out.raw("}").toBuffer();
  }

  private static void parseLines(JsonParser p, Agents agents, Lines lines) throws java.io.IOException {
    JsonToken t;
    while ((t = p.nextToken()) != JsonToken.END_ARRAY) {
      if (t != JsonToken.START_OBJECT) throw INVALID;
      int agent = -1, product = -1;
      long premium = -1;
      while ((t = p.nextToken()) == JsonToken.FIELD_NAME) {
        String field = p.currentName(); // noms canonicalisés par Jackson : pas d'allocation
        t = p.nextToken();
        switch (field) {
          case "agent" -> {
            if (t != JsonToken.VALUE_STRING) throw INVALID;
            int l = p.getTextLength();
            if (l < 1 || l > 32) throw INVALID;
            agent = agents.find(p.getTextCharacters(), p.getTextOffset(), l);
          }
          case "product" -> {
            if (t != JsonToken.VALUE_STRING) throw INVALID;
            product = product(p.getTextCharacters(), p.getTextOffset(), p.getTextLength());
            if (product < 0) throw INVALID;
          }
          case "premium_cents" -> {
            if (t != JsonToken.VALUE_NUMBER_INT) throw INVALID;
            JsonParser.NumberType nt = p.getNumberType();
            if (nt != JsonParser.NumberType.INT && nt != JsonParser.NumberType.LONG) throw INVALID;
            premium = p.getLongValue();
            if (premium < 0 || premium > 100_000_000) throw INVALID;
          }
          default -> p.skipChildren();
        }
      }
      if (agent < 0 || product < 0 || premium < 0) throw INVALID;
      lines.add(agent, product, (int) premium);
    }
  }

  private static int product(char[] c, int off, int len) {
    return switch (len) {
      case 4 -> same(c, off, "AUTO") ? 0 : -1;
      case 5 -> same(c, off, "SANTE") ? 2 : -1;
      case 10 -> same(c, off, "HABITATION") ? 1 : same(c, off, "PREVOYANCE") ? 3 : -1;
      default -> -1;
    };
  }

  private static boolean same(char[] c, int off, String lit) {
    for (int i = 0, l = lit.length(); i < l; i++) if (c[off + i] != lit.charAt(i)) return false;
    return true;
  }

  // ---- écriture JSON directe dans un byte[], enveloppé sans copie dans un Buffer Vert.x ----

  private static final byte[] HEX = "0123456789abcdef".getBytes(StandardCharsets.ISO_8859_1);

  private static final class JsonOut {
    private byte[] b;
    private int n;

    JsonOut(int capacity) {
      b = new byte[capacity];
    }

    private void ensure(int extra) {
      if (n + extra > b.length) b = Arrays.copyOf(b, Math.max(b.length * 2, n + extra));
    }

    JsonOut ascii(byte c) {
      ensure(1);
      b[n++] = c;
      return this;
    }

    /** Texte ASCII sans échappement (littéraux JSON du code). */
    JsonOut raw(String s) {
      int l = s.length();
      ensure(l);
      for (int i = 0; i < l; i++) b[n++] = (byte) s.charAt(i);
      return this;
    }

    JsonOut num(long v) {
      ensure(20);
      if (v < 0) {
        if (v == Long.MIN_VALUE) return raw("-9223372036854775808");
        b[n++] = '-';
        v = -v;
      }
      int start = n;
      do {
        b[n++] = (byte) ('0' + (int) (v % 10));
        v /= 10;
      } while (v != 0);
      for (int i = start, j = n - 1; i < j; i++, j--) {
        byte t = b[i];
        b[i] = b[j];
        b[j] = t;
      }
      return this;
    }

    /** Représentation la plus courte qui relit le même double (Double.toString, JDK 19+). */
    JsonOut dbl(double d) {
      return raw(Double.toString(d));
    }

    JsonOut hex16(long v) {
      ensure(16);
      for (int i = 0; i < 16; i++) b[n++] = HEX[(int) (v >>> (60 - 4 * i)) & 15];
      return this;
    }

    /** Chaîne JSON : ", \ et contrôles échappés ; hors ASCII en \\uXXXX (sûr même pour un surrogate isolé). */
    JsonOut str(String s) {
      int l = s.length();
      ensure(l + 2);
      b[n++] = '"';
      for (int i = 0; i < l; i++) {
        char c = s.charAt(i);
        if (c >= 0x20 && c < 0x7F && c != '"' && c != '\\') {
          ensure(1);
          b[n++] = (byte) c;
        } else if (c == '"' || c == '\\') {
          ensure(2);
          b[n++] = '\\';
          b[n++] = (byte) c;
        } else {
          ensure(6);
          b[n++] = '\\';
          b[n++] = 'u';
          b[n++] = HEX[(c >>> 12) & 15];
          b[n++] = HEX[(c >>> 8) & 15];
          b[n++] = HEX[(c >>> 4) & 15];
          b[n++] = HEX[c & 15];
        }
      }
      ensure(1);
      b[n++] = '"';
      return this;
    }

    Buffer toBuffer() {
      return BufferInternal.buffer(Unpooled.wrappedBuffer(b, 0, n));
    }
  }
}
