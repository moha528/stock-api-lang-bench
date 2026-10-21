// Point d'entrée : configuration, pool Postgres, démarrage HTTP, arrêt propre.
import postgres from 'postgres';
import { createDb } from './db.js';
import { createApp, uWS } from './router.js';

const PORT = Number(process.env.PORT ?? 8080);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://stock:stock@db:5432/stock';
const DB_POOL_MAX = Number(process.env.DB_POOL_MAX ?? 20);

const sql = postgres(DATABASE_URL, {
  max: DB_POOL_MAX,
  prepare: true,
  fetch_types: false, // pas de types tableau/personnalisés : évite une requête au démarrage de chaque connexion
  idle_timeout: 0,
  onnotice: () => {},
  // bigint (int8, oid 20) -> nombre JSON. Toutes les valeurs du schéma tiennent dans 2^53.
  types: {
    int8: { to: 20, from: [20], serialize: (x) => '' + x, parse: (x) => +x },
  },
});

const app = createApp(createDb(sql));

let listenSocket = null;
app.listen('0.0.0.0', PORT, (socket) => {
  if (!socket) {
    console.error(`Impossible d'écouter sur le port ${PORT}`);
    process.exit(1);
  }
  listenSocket = socket;
  console.log(`stock-api node à l'écoute sur :${PORT}`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // 1. plus de nouvelles connexions ; 2. on laisse finir les requêtes SQL en cours ;
  // 3. on ferme les connexions HTTP restantes (keep-alive).
  if (listenSocket) uWS.us_listen_socket_close(listenSocket);
  listenSocket = null;
  try {
    await sql.end({ timeout: 5 });
  } catch {}
  await new Promise((r) => setImmediate(r));
  app.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
