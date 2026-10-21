// Implémentation de référence de SPEC-heavy.md, lente mais lisible : elle fixe le résultat attendu.
import { createHash } from 'node:crypto';

const MASK = (1n << 64n) - 1n;

export function rng(seed) {
  let state = BigInt(seed) & MASK;
  const next = () => {
    state = (state + 0x9E3779B97F4A7C15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK;
    return z ^ (z >> 31n);
  };
  return {
    next,
    uniform: () => Number(next() >> 11n) * 2 ** -53,
    below: (m) => Number(next() % BigInt(m)),
  };
}

const hex16 = (v) => v.toString(16).padStart(16, '0');

export function hash(rounds = 200000, seed = 42) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(seed));
  let h = createHash('sha256').update(b).digest();
  for (let i = 1; i < rounds; i++) h = createHash('sha256').update(h).digest();
  return { digest: h.toString('hex') };
}

export function montecarlo(paths = 20000, steps = 252, seed = 42) {
  const r = rng(seed);
  const s0 = 100.0, k = 100.0, mu = 0.05, sigma = 0.2, SQRT3 = 1.7320508075688772;
  const dt = 1.0 / steps, sqrtDt = Math.sqrt(dt), drift = mu * dt, vol = sigma * sqrtDt;
  let sum = 0.0;
  for (let p = 0; p < paths; p++) {
    let s = s0;
    for (let t = 0; t < steps; t++) {
      const z = (2.0 * r.uniform() - 1.0) * SQRT3;
      s = s * (1.0 + drift + vol * z);
    }
    sum += Math.max(s - k, 0.0);
  }
  return { price: sum / paths, paths, steps };
}

export function reconcile(n = 100000, seed = 42) {
  const r = rng(seed);
  const payments = [];
  for (let i = 0; i < n; i++) {
    const ref = 'PAY-' + hex16(r.next());
    payments.push([ref, 100 + r.below(1000000)]);
  }
  const bank = [];
  for (const [ref, amount] of payments) {
    const x = r.below(100);
    if (x < 5) continue;
    if (x < 10) bank.push([ref, amount + 1 + r.below(500)]);
    else bank.push([ref, amount]);
  }
  for (let i = 0; i < Math.floor(n / 50); i++) {
    const ref = 'PAY-' + hex16(r.next());
    bank.push([ref, 100 + r.below(1000000)]);
  }
  for (let i = bank.length - 1; i >= 1; i--) {
    const j = r.below(i + 1);
    [bank[i], bank[j]] = [bank[j], bank[i]];
  }
  const map = new Map(payments);
  let matched = 0, mismatched = 0, unknown = 0, matched_cents = 0;
  for (const [ref, amount] of bank) {
    const a = map.get(ref);
    if (a === undefined) unknown++;
    else if (a === amount) { matched++; matched_cents += amount; }
    else mismatched++;
  }
  return { matched, mismatched, missing: n - matched - mismatched, unknown, matched_cents };
}

export function sort(n = 100000, seed = 42) {
  const r = rng(seed);
  const A = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const xs = [];
  for (let i = 0; i < n; i++) {
    let s = '';
    for (let c = 0; c < 16; c++) s += A[r.below(36)];
    xs.push(s);
  }
  xs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let h = 0xcbf29ce484222325n;
  for (const s of xs) {
    for (const ch of s + '\n') h = ((h ^ BigInt(ch.charCodeAt(0))) * 0x100000001b3n) & MASK;
  }
  return { first: xs[0], last: xs[n - 1], fnv: hex16(h) };
}

const RATES = { AUTO: 800, HABITATION: 1000, SANTE: 600, PREVOYANCE: 1200 };

export function commissions(body) {
  const by = new Map();
  for (const l of body.lines) {
    let a = by.get(l.agent);
    if (!a) by.set(l.agent, (a = { agent: l.agent, lines: [], premium_cents: 0 }));
    a.lines.push(l);
    a.premium_cents += l.premium_cents;
  }
  const agents = [...by.values()].map((a) => {
    const bonus = a.premium_cents >= 5000000 ? 100 : 0;
    const commission_cents = a.lines.reduce((s, l) => s + Math.floor((l.premium_cents * (RATES[l.product] + bonus)) / 10000), 0);
    return { agent: a.agent, lines: a.lines.length, premium_cents: a.premium_cents, commission_cents };
  });
  agents.sort((x, y) => y.commission_cents - x.commission_cents || (x.agent < y.agent ? -1 : x.agent > y.agent ? 1 : 0));
  return { agents, total_commission_cents: agents.reduce((s, a) => s + a.commission_cents, 0) };
}

// Lot de commissions déterministe, partagé par le contrôle et par k6
export function commissionsBody(lines = 20000, agents = 300) {
  const P = ['AUTO', 'HABITATION', 'SANTE', 'PREVOYANCE'];
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push({
      agent: 'AG-' + String((i * 7919) % agents).padStart(4, '0'),
      product: P[(i * 31) % 4],
      premium_cents: 5000 + ((i * 104729) % 140000),
    });
  }
  return { lines: out };
}
