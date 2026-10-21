// Scénarios k6 des traitements lourds (SPEC-heavy.md), identiques pour Rust et Java.
// Variables : TARGET (http://rust:8080), SCENARIO (hash|montecarlo|reconcile|sort|commissions), VUS, DURATION, OUT
import http from 'k6/http';
import { check } from 'k6';

const TARGET = __ENV.TARGET;
const SCENARIO = __ENV.SCENARIO;

// ITERATIONS : nombre fixe de requêtes (mesure à froid) au lieu d'une durée
export const options = {
  vus: Number(__ENV.VUS || 1),
  ...(__ENV.ITERATIONS ? { iterations: Number(__ENV.ITERATIONS) } : { duration: __ENV.DURATION || '20s' }),
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: true,
};

// Même lot que commissionsBody() dans heavy-reference.mjs
function commissionsBody(lines, agents) {
  const P = ['AUTO', 'HABITATION', 'SANTE', 'PREVOYANCE'];
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push({
      agent: 'AG-' + String((i * 7919) % agents).padStart(4, '0'),
      product: P[(i * 31) % 4],
      premium_cents: 5000 + ((i * 104729) % 140000),
    });
  }
  return JSON.stringify({ lines: out });
}
const BODY = SCENARIO === 'commissions' ? commissionsBody(20000, 300) : null;
const PARAMS = { headers: { 'Content-Type': 'application/json' }, tags: { name: SCENARIO }, timeout: '120s' };

export default function () {
  // Graine variable : pas de cache possible, travail identique en coût
  const seed = Math.floor(Math.random() * 1e9);
  let r;
  switch (SCENARIO) {
    case 'hash': r = http.get(`${TARGET}/cpu/hash?seed=${seed}`, PARAMS); break;
    case 'montecarlo': r = http.get(`${TARGET}/cpu/montecarlo?seed=${seed}`, PARAMS); break;
    case 'reconcile': r = http.get(`${TARGET}/cpu/reconcile?seed=${seed}`, PARAMS); break;
    case 'sort': r = http.get(`${TARGET}/cpu/sort?seed=${seed}`, PARAMS); break;
    case 'commissions': r = http.post(`${TARGET}/cpu/commissions`, BODY, PARAMS); break;
    default: throw new Error(`scénario inconnu : ${SCENARIO}`);
  }
  check(r, { '200': (x) => x.status === 200 });
}

export function handleSummary(data) {
  const out = {};
  if (__ENV.OUT) out[__ENV.OUT] = JSON.stringify(data);
  return out;
}
