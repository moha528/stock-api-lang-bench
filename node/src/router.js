// Routage HTTP (uWebSockets.js) : validation des entrées, appel de la couche données, sérialisation JSON.
import { createRequire } from 'node:module';

// Le wrapper ESM du paquet pointe vers un index.js absent : chargement CommonJS direct.
export const uWS = createRequire(import.meta.url)('uWebSockets.js');

const S200 = '200 OK';
const S201 = '201 Created';
const S400 = '400 Bad Request';
const S404 = '404 Not Found';
const S409 = '409 Conflict';
const S500 = '500 Internal Server Error';

const HEALTH = '{"status":"ok"}';
const ERR_INVALID = '{"error":"invalid_input"}';
const ERR_NOT_FOUND = '{"error":"not_found"}';
const ERR_CONFLICT = '{"error":"conflict"}';
const ERR_STOCK = '{"error":"insufficient_stock"}';
const ERR_INTERNAL = '{"error":"internal"}';

const MAX_BODY = 1 << 20; // 1 Mio, au-delà : 400
const INT32_MAX = 2147483647;
const INT64_MAX = '9223372036854775807';
const INT_RE = /^[+-]?\d+$/;

function send(res, status, body) {
  res.writeStatus(status).writeHeader('Content-Type', 'application/json').end(body);
}

// Écriture différée (après un await) : regroupée en un seul syscall via cork.
function reply(res, status, body) {
  if (res.aborted) return;
  res.cork(() => send(res, status, body));
}

function fail(res) {
  reply(res, S500, ERR_INTERNAL);
}

// Entier int64 en texte -> number (sûr), string de chiffres (positif au-delà de 2^53), ou null.
// Les négatifs hors plage sûre ne servent à rien ici : -1 suffit pour les rejeter.
function parseInt64(s) {
  if (s === undefined || !INT_RE.test(s)) return null;
  const neg = s.charCodeAt(0) === 45; // '-'
  let d = neg || s.charCodeAt(0) === 43 ? s.slice(1) : s;
  if (d.length > 1 && d.charCodeAt(0) === 48) d = d.replace(/^0+(?=\d)/, '');
  if (d.length < 16) return neg ? -Number(d) : Number(d);
  if (d.length > 19 || (d.length === 19 && d > INT64_MAX)) return null;
  if (neg) return -1;
  const n = Number(d);
  return Number.isSafeInteger(n) ? n : d;
}

function parseId(s) {
  const v = parseInt64(s);
  return v !== null && (typeof v === 'string' || v > 0) ? v : null;
}

// Première occurrence de chaque clé, comme URLSearchParams.get, sans allouer d'objet.
function queryParam(query, key) {
  if (!query) return undefined;
  const prefix = key + '=';
  let start = 0;
  while (start <= query.length) {
    let end = query.indexOf('&', start);
    if (end === -1) end = query.length;
    if (query.startsWith(prefix, start)) {
      const raw = query.slice(start + prefix.length, end);
      if (raw.indexOf('%') === -1 && raw.indexOf('+') === -1) return raw;
      try { return decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { return ''; }
    }
    start = end + 1;
  }
  return undefined;
}

// Longueur en caractères Unicode (points de code), sans coût pour les chaînes courtes.
function isStr(v, max) {
  if (typeof v !== 'string' || v.length === 0) return false;
  if (v.length <= max) return true;
  let n = 0;
  for (const _ of v) if (++n > max) return false;
  return true;
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Lit tout le corps puis appelle cb(objet JSON) ; répond 400 si trop gros ou JSON invalide.
function readJson(res, cb) {
  let chunks = null;
  let size = 0;
  res.onData((ab, isLast) => {
    if (size < 0) return;
    size += ab.byteLength;
    if (size > MAX_BODY) {
      size = -1;
      return reply(res, S400, ERR_INVALID);
    }
    if (!isLast) {
      (chunks ??= []).push(Buffer.from(ab.slice(0))); // ab est invalidé après le retour
      return;
    }
    // Cas courant : un seul chunk, décodé directement sans copie.
    const text = chunks === null
      ? Buffer.from(ab).toString('utf8')
      : Buffer.concat([...chunks, Buffer.from(ab)]).toString('utf8');
    let body;
    try { body = JSON.parse(text); } catch { return reply(res, S400, ERR_INVALID); }
    cb(body);
  });
}

function onAborted(res) {
  res.onAborted(() => { res.aborted = true; });
}

export function createApp(db) {
  const app = uWS.App();

  app.get('/health', (res) => {
    send(res, S200, HEALTH);
  });

  app.get('/products', (res, req) => {
    const q = req.getQuery();
    const ls = queryParam(q, 'limit');
    const os = queryParam(q, 'offset');
    const limit = ls === undefined ? 50 : parseInt64(ls);
    const offset = os === undefined ? 0 : parseInt64(os);
    if (typeof limit !== 'number' || limit < 1 || limit > 100
      || offset === null || (typeof offset === 'number' && offset < 0)) {
      return send(res, S400, ERR_INVALID);
    }
    onAborted(res);
    db.listProducts(limit, offset).then(
      (rows) => reply(res, S200, JSON.stringify(rows)),
      () => fail(res),
    );
  });

  app.get('/products/:id', (res, req) => {
    const id = parseId(req.getParameter(0));
    if (id === null) return send(res, S400, ERR_INVALID);
    onAborted(res);
    db.getProduct(id).then(
      (row) => (row ? reply(res, S200, JSON.stringify(row)) : reply(res, S404, ERR_NOT_FOUND)),
      () => fail(res),
    );
  });

  app.post('/products', (res) => {
    onAborted(res);
    readJson(res, (b) => {
      if (!isObject(b)
        || !isStr(b.sku, 64)
        || !isStr(b.name, 200)
        || !isInt(b.quantity, 0, INT32_MAX)
        || !isInt(b.price_cents, 0, Number.MAX_SAFE_INTEGER)) {
        return reply(res, S400, ERR_INVALID);
      }
      db.createProduct(b.sku, b.name, b.quantity, b.price_cents).then(
        (row) => (row ? reply(res, S201, JSON.stringify(row)) : reply(res, S409, ERR_CONFLICT)),
        () => fail(res),
      );
    });
  });

  app.post('/products/:id/movements', (res, req) => {
    const id = parseId(req.getParameter(0));
    if (id === null) return send(res, S400, ERR_INVALID);
    onAborted(res);
    readJson(res, (b) => {
      if (!isObject(b) || !isInt(b.delta, -1000000, 1000000) || b.delta === 0 || !isStr(b.reason, 100)) {
        return reply(res, S400, ERR_INVALID);
      }
      db.applyMovement(id, b.delta, b.reason).then(
        async (row) => {
          if (row) {
            return reply(res, S200,
              `{"product_id":${id},"quantity":${row.quantity},"movement_id":${row.id}}`);
          }
          const exists = await db.productExists(id);
          if (exists) reply(res, S409, ERR_STOCK);
          else reply(res, S404, ERR_NOT_FOUND);
        },
      ).catch(() => fail(res));
    });
  });

  app.get('/stats', (res) => {
    onAborted(res);
    db.stats().then(
      ([products, totalQuantity, totalValue]) => reply(res, S200,
        `{"products":${products},"total_quantity":${totalQuantity},"total_value_cents":${totalValue}}`),
      () => fail(res),
    );
  });

  // Toute autre route, ou méthode non prévue sur une route connue : 404.
  app.any('/*', (res) => {
    send(res, S404, ERR_NOT_FOUND);
  });

  return app;
}
