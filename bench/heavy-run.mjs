// Bench des traitements lourds, Rust contre Java. Pour chaque langage et chaque traitement, sur un conteneur neuf :
//   1. froid      : les 30 premières requêtes, une à la fois (chauffe du JIT) ;
//   2. chauffe    : k6, 2 × CPU utilisateurs, non mesurée ;
//   3. unitaire   : k6, 1 utilisateur (coût d'une requête isolée) ;
//   4. débit      : k6, 2 × CPU utilisateurs (traitement en lot, machine pleine) ;
//   5. surcharge  : k6, 64 utilisateurs (file d'attente, pression mémoire).
// Usage (racine du projet) : node bench/heavy-run.mjs [rust java] [--only=hash,sort]
// Variables : APP_CPUS (1.0), BENCH_DURATION (20s), BENCH_OUT (results-heavy)
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const exec = promisify(execCb);
const PORTS = { rust: 8082, java: 8084 };
const PATHS = {
  hash: '/cpu/hash', montecarlo: '/cpu/montecarlo', reconcile: '/cpu/reconcile', sort: '/cpu/sort', commissions: '/cpu/commissions',
};
const args = process.argv.slice(2);
const langs = args.filter((a) => !a.startsWith('--')).length ? args.filter((a) => !a.startsWith('--')) : Object.keys(PORTS);
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const WORKLOADS = only ?? Object.keys(PATHS);
const APP_CPUS = Number(process.env.APP_CPUS || '1.0');
const CORES = Math.max(1, Math.round(APP_CPUS));
const DURATION = process.env.BENCH_DURATION || '20s';
const RES = `bench/${process.env.BENCH_OUT || 'results-heavy'}/cpu-${APP_CPUS}`;
const COLD_REQUESTS = 30;
const PHASES = [
  { name: 'unit', vus: 1 },
  { name: 'throughput', vus: 2 * CORES },
  { name: 'overload', vus: 64 },
];

mkdirSync(`${RES}/raw`, { recursive: true });
const sh = (cmd) => exec(cmd, { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function parseMem(s) {
  const m = /([\d.]+)\s*([KMG]i?B|B)/.exec(s);
  if (!m) return 0;
  return Number(m[1]) * { B: 1 / 1048576, KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[m[2]];
}

async function sampleStats(container) {
  const out = await sh(`docker stats --no-stream --format "{{.CPUPerc}};{{.MemUsage}}" ${container}`);
  const [cpu, mem] = out.split(';');
  return { cpu: parseFloat(cpu), mem: parseMem(mem.split('/')[0]) };
}

function startSampler(container) {
  const samples = [];
  let running = true;
  const done = (async () => {
    await sleep(2000);
    while (running) {
      try { samples.push(await sampleStats(container)); } catch { /* conteneur mort */ }
    }
  })();
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return async () => {
    running = false;
    await done;
    return {
      cpu_avg: avg(samples.map((s) => s.cpu)),
      mem_peak_mib: samples.length ? Math.max(...samples.map((s) => s.mem)) : 0,
    };
  };
}

// Mesure à froid depuis k6, dans le réseau Docker : depuis l'hôte Windows, le transport de Docker Desktop
// ajoute des pics de 50 ms sur les gros corps. --out json donne la durée de chaque requête, dans l'ordre.
async function coldCurve(lang, w) {
  const file = `${RES}/raw/${lang}-${w}-cold.ndjson`;
  await sh(`docker compose run --rm -e TARGET=http://${lang}:8080 -e SCENARIO=${w} -e VUS=1 -e ITERATIONS=${COLD_REQUESTS} k6 run --quiet --no-color --out json=/${file} heavy.js`);
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((p) => p.type === 'Point' && p.metric === 'http_req_duration')
    .sort((a, b) => a.data.time.localeCompare(b.data.time))
    .map((p) => p.data.value);
}

async function k6(lang, w, vus, duration, out) {
  const outArg = out ? `-e OUT=/${out}` : '';
  await sh(`docker compose run --rm -e TARGET=http://${lang}:8080 -e SCENARIO=${w} -e VUS=${vus} -e DURATION=${duration} ${outArg} k6 run --quiet --no-color heavy.js`)
    .catch((e) => log(`  k6 a signalé des erreurs (${e.code})`));
}

async function freshContainer(lang) {
  await sh(`docker compose rm -sf ${lang}`).catch(() => {});
  const t0 = performance.now();
  await sh(`docker compose up -d --no-build ${lang}`);
  for (;;) {
    try { if ((await fetch(`http://localhost:${PORTS[lang]}/health`)).ok) break; } catch { /* pas encore prêt */ }
    await sleep(25);
  }
  return Math.round(performance.now() - t0);
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function benchLang(lang) {
  const container = `sandbox-${lang}-1`;
  const result = { lang, app_cpus: APP_CPUS, workloads: {} };
  for (const w of WORKLOADS) {
    const startup_ms = await freshContainer(lang);
    await sleep(1000);
    const idle = await sampleStats(container);
    const cold = await coldCurve(lang, w);
    log(`[${lang}] ${w} : 1re requête ${cold[0].toFixed(1)} ms, médiane des 5 dernières ${median(cold.slice(-5)).toFixed(1)} ms`);

    await k6(lang, w, 2 * CORES, '15s');
    const phases = {};
    for (const p of PHASES) {
      const stop = startSampler(container);
      const file = `${RES}/raw/${lang}-${w}-${p.name}.json`;
      const run = k6(lang, w, p.vus, DURATION, file);
      await sleep(parseInt(DURATION) * 1000 + 1000);
      const res = await stop();
      await run;
      const d = JSON.parse(readFileSync(file, 'utf8')).metrics;
      const dur = d.http_req_duration.values;
      phases[p.name] = {
        vus: p.vus, rps: d.http_reqs.values.rate,
        p50: dur.med, p95: dur['p(95)'], p99: dur['p(99)'], max: dur.max,
        errors: d.http_req_failed?.values.rate ?? 0, ...res,
      };
      log(`  ${p.name} (${p.vus} VUs) : ${phases[p.name].rps.toFixed(1)} req/s, p50 ${dur.med.toFixed(1)} ms, p99 ${dur['p(99)'].toFixed(1)} ms, CPU ${res.cpu_avg.toFixed(0)} %, RAM ${res.mem_peak_mib.toFixed(0)} Mo`);
    }
    const [oom, restarts] = (await sh(`docker inspect --format "{{.State.OOMKilled}} {{.RestartCount}}" ${container}`)).split(' ');
    result.workloads[w] = {
      startup_ms, idle_mem_mib: idle.mem, cold_ms: cold.map((x) => Math.round(x * 100) / 100), phases,
      oom_killed: oom === 'true', restarts: Number(restarts),
    };
  }
  await sh(`docker compose rm -sf ${lang}`);
  return result;
}

let prev = {};
try { prev = JSON.parse(readFileSync(`${RES}/results.json`, 'utf8')); } catch { /* premier run */ }
for (const lang of langs) {
  const r = await benchLang(lang);
  prev[lang] = { ...prev[lang], ...r, workloads: { ...prev[lang]?.workloads, ...r.workloads }, date: new Date().toISOString(), duration: DURATION };
  writeFileSync(`${RES}/results.json`, JSON.stringify(prev, null, 2));
}

const f = (n, d = 0) => (n == null ? '—' : n.toFixed(d));
let md = `# Traitements lourds : Rust contre Java\n\nConteneur app : ${APP_CPUS} vCPU, 512 Mo. Durée par phase : ${DURATION}. Conteneur neuf pour chaque traitement.\n`;
for (const w of Object.keys(PATHS)) {
  const rows = Object.values(prev).filter((r) => r.workloads[w]);
  if (!rows.length) continue;
  md += `\n## ${w}\n\n| Langage | 1re requête (ms) | Chaude, 1 req. (ms) | Débit (req/s) | Débit / vCPU | p99 débit (ms) | p99 surcharge (ms) | CPU (%) | RAM max (Mo) | OOM |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---|\n`;
  for (const r of rows) {
    const x = r.workloads[w], u = x.phases.unit, t = x.phases.throughput, o = x.phases.overload;
    const ram = Math.max(u.mem_peak_mib, t.mem_peak_mib, o.mem_peak_mib);
    md += `| ${r.lang} | ${f(x.cold_ms[0], 1)} | ${f(u.p50, 1)} | ${f(t.rps, 1)} | ${f(t.rps / (t.cpu_avg / 100), 1)} | ${f(t.p99, 1)} | ${f(o.p99, 1)} | ${f(t.cpu_avg)} | ${f(ram)} | ${x.oom_killed ? 'oui' : 'non'} |\n`;
  }
}
writeFileSync(`${RES}/RESULTS.md`, md);
log(`Terminé : ${RES}/RESULTS.md`);
