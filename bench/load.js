// Scénarios de charge k6, identiques pour les 4 implémentations.
// Variables : TARGET (http://node:8080), SCENARIO (read|list|write|mixed), VUS, DURATION, OUT (fichier résumé JSON)
import http from 'k6/http';
import { check } from 'k6';

const TARGET = __ENV.TARGET;
const SCENARIO = __ENV.SCENARIO || 'mixed';
const RUN_ID = Math.floor(Math.random() * 1e9);
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };

export const options = {
  vus: Number(__ENV.VUS || 50),
  duration: __ENV.DURATION || '20s',
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: false,
  noConnectionReuse: false,
};

const randId = () => 1 + Math.floor(Math.random() * 10000);

function read() {
  const r = http.get(`${TARGET}/products/${randId()}`, { tags: { op: 'read', name: 'read' } });
  check(r, { 'read 200': (x) => x.status === 200 });
}

function list(limit) {
  // Offset faible : on veut mesurer la sérialisation côté app, pas le scan d'OFFSET côté Postgres
  const offset = Math.floor(Math.random() * 1000);
  const r = http.get(`${TARGET}/products?limit=${limit}&offset=${offset}`, { tags: { op: 'list', name: 'list' } });
  check(r, { 'list 200': (x) => x.status === 200 });
}

function move() {
  const delta = Math.random() < 0.5 ? -1 : 1;
  const r = http.post(`${TARGET}/products/${randId()}/movements`,
    JSON.stringify({ delta, reason: delta < 0 ? 'sale' : 'restock' }), { ...JSON_HEADERS, tags: { op: 'move', name: 'move' } });
  check(r, { 'move 200': (x) => x.status === 200 });
}

function create() {
  const sku = `B-${RUN_ID}-${__VU}-${__ITER}`;
  const r = http.post(`${TARGET}/products`,
    JSON.stringify({ sku, name: `Bench ${sku}`, quantity: 10, price_cents: 999 }), { ...JSON_HEADERS, tags: { op: 'create', name: 'create' } });
  check(r, { 'create 201': (x) => x.status === 201 });
}

function stats() {
  const r = http.get(`${TARGET}/stats`, { tags: { op: 'stats', name: 'stats' } });
  check(r, { 'stats 200': (x) => x.status === 200 });
}

export default function () {
  switch (SCENARIO) {
    case 'read': return read();
    case 'list': return list(100);
    case 'write': return move();
    default: {
      // Mix « réaliste » : 70 % lecture, 15 % liste, 10 % mouvement, 4 % création, 1 % stats
      const p = Math.random();
      if (p < 0.70) return read();
      if (p < 0.85) return list(50);
      if (p < 0.95) return move();
      if (p < 0.99) return create();
      return stats();
    }
  }
}

export function handleSummary(data) {
  const out = {};
  if (__ENV.OUT) out[__ENV.OUT] = JSON.stringify(data);
  return out;
}
