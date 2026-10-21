// Vérifie qu'une implémentation renvoie exactement les résultats de heavy-reference.mjs (SPEC-heavy.md).
// Usage : node heavy-check.mjs http://localhost:8082 [--quick]
import * as ref from './heavy-reference.mjs';

const base = process.argv[2] ?? 'http://localhost:8080';
const quick = process.argv.includes('--quick');
let failures = 0;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: typeof body === 'string' ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}

// Égalité de valeurs JSON, ordre des clés indifférent, nombres comparés exactement
function same(a, b) {
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && typeof a === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b ?? {}).sort();
    return JSON.stringify(ka) === JSON.stringify(kb) && ka.every((k) => same(a[k], b[k]));
  }
  return a === b;
}

function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ' -> ' + detail.slice(0, 300) : ''}`); }
}

async function expect(name, path, expected, body) {
  const r = await call(body ? 'POST' : 'GET', path, body);
  check(name, r.status === 200 && same(r.json, expected), `HTTP ${r.status} ${r.text} attendu ${JSON.stringify(expected)}`);
}

const cases = [
  ['hash petit', '/cpu/hash?rounds=1&seed=0', () => ref.hash(1, 0)],
  ['hash 1000 tours', '/cpu/hash?rounds=1000&seed=7', () => ref.hash(1000, 7)],
  ['montecarlo petit', '/cpu/montecarlo?paths=50&steps=10&seed=1', () => ref.montecarlo(50, 10, 1)],
  ['montecarlo 1000x252', '/cpu/montecarlo?paths=1000&steps=252&seed=99', () => ref.montecarlo(1000, 252, 99)],
  ['reconcile petit', '/cpu/reconcile?n=60&seed=3', () => ref.reconcile(60, 3)],
  ['reconcile 5000', '/cpu/reconcile?n=5000&seed=11', () => ref.reconcile(5000, 11)],
  ['sort 1', '/cpu/sort?n=1&seed=5', () => ref.sort(1, 5)],
  ['sort 5000', '/cpu/sort?n=5000&seed=13', () => ref.sort(5000, 13)],
  ['seed max', '/cpu/reconcile?n=100&seed=9007199254740991', () => ref.reconcile(100, 9007199254740991)],
];
if (!quick) {
  cases.push(
    ['hash défaut', '/cpu/hash', () => ref.hash()],
    ['montecarlo défaut', '/cpu/montecarlo', () => ref.montecarlo()],
    ['reconcile défaut', '/cpu/reconcile', () => ref.reconcile()],
    ['sort défaut', '/cpu/sort', () => ref.sort()],
  );
}
for (const [name, path, fn] of cases) await expect(name, path, fn());

const small = { lines: [
  { agent: 'AG-2', product: 'AUTO', premium_cents: 10001, x: 1 },
  { agent: 'AG-1', product: 'SANTE', premium_cents: 5000000 },
  { agent: 'AG-2', product: 'PREVOYANCE', premium_cents: 333 },
  { agent: 'AG-3', product: 'HABITATION', premium_cents: 0 },
] };
await expect('commissions petit lot (bonus, tri, champ inconnu)', '/cpu/commissions', ref.commissions(small), small);
const egal = { lines: [{ agent: 'B', product: 'AUTO', premium_cents: 10000 }, { agent: 'A', product: 'AUTO', premium_cents: 10000 }] };
await expect('commissions égalité triée par agent', '/cpu/commissions', ref.commissions(egal), egal);
const big = ref.commissionsBody(quick ? 2000 : 20000);
await expect('commissions lot de référence', '/cpu/commissions', ref.commissions(big), big);

const bad = [
  ['GET', '/cpu/hash?rounds=0'], ['GET', '/cpu/hash?rounds=5000001'], ['GET', '/cpu/hash?rounds=abc'],
  ['GET', '/cpu/hash?seed=-1'], ['GET', '/cpu/hash?seed=9007199254740992'],
  ['GET', '/cpu/montecarlo?paths=0'], ['GET', '/cpu/montecarlo?steps=10001'],
  ['GET', '/cpu/reconcile?n=1000001'], ['GET', '/cpu/sort?n=0'],
  ['POST', '/cpu/commissions', '{not json'],
  ['POST', '/cpu/commissions', { lines: [] }],
  ['POST', '/cpu/commissions', { lines: [{ agent: 'A', product: 'VELO', premium_cents: 1 }] }],
  ['POST', '/cpu/commissions', { lines: [{ agent: '', product: 'AUTO', premium_cents: 1 }] }],
  ['POST', '/cpu/commissions', { lines: [{ agent: 'A', product: 'AUTO', premium_cents: -1 }] }],
  ['POST', '/cpu/commissions', { lines: [{ agent: 'A', product: 'AUTO', premium_cents: 1.5 }] }],
  ['POST', '/cpu/commissions', { lines: [{ agent: 'A', product: 'AUTO' }] }],
];
for (const [m, p, b] of bad) {
  const r = await call(m, p, b);
  check(`400 ${m} ${p} ${b ? JSON.stringify(b).slice(0, 60) : ''}`, r.status === 400 && r.json?.error === 'invalid_input', `HTTP ${r.status} ${r.text}`);
}

console.log(failures ? `\n${failures} échec(s)` : '\nRésultats identiques à la référence');
process.exit(failures ? 1 : 0);
