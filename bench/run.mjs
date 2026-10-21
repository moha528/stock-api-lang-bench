// Orchestrateur de bench : pour chaque langage, démarre l'app seule, mesure démarrage / RAM au repos,
// chauffe, puis enchaîne les scénarios k6 en échantillonnant CPU et RAM du conteneur.
// Usage (racine du projet) : node bench/run.mjs [node rust go java]
// Variables : BENCH_DURATION (20s), APP_CPUS (quota CPU des apps, 1.0), BENCH_OUT (dossier sous bench/, results)
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const exec = promisify(execCb);
const PORTS = { node: 8081, rust: 8082, go: 8083, java: 8084 };
const langs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PORTS);
const DURATION = process.env.BENCH_DURATION || '20s';
const TESTS = [
  { name: 'read', scenario: 'read', vus: 100 },
  { name: 'list', scenario: 'list', vus: 100 },
  { name: 'write', scenario: 'write', vus: 100 },
  { name: 'mixed-10', scenario: 'mixed', vus: 10 },
  { name: 'mixed-100', scenario: 'mixed', vus: 100 },
  { name: 'mixed-500', scenario: 'mixed', vus: 500 },
];

const RES = process.env.BENCH_OUT || 'results';
const APP_CPUS = process.env.APP_CPUS || '1.0';
mkdirSync(`bench/${RES}/raw`, { recursive: true });
const sh = (cmd) => exec(cmd, { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function parseMem(s) {
  const m = /([\d.]+)\s*([KMG]i?B|B)/.exec(s);
  if (!m) return 0;
  const f = { B: 1 / 1048576, KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[m[2]];
  return Number(m[1]) * f;
}

async function sampleStats(container) {
  const out = await sh(`docker stats --no-stream --format "{{.Name}};{{.CPUPerc}};{{.MemUsage}}" ${container} sandbox-db-1`);
  const rows = Object.fromEntries(out.split('\n').map((l) => {
    const [name, cpu, mem] = l.trim().split(';');
    return [name, { cpu: parseFloat(cpu), mem: parseMem(mem.split('/')[0]) }];
  }));
  return { ...rows[container], db_cpu: rows['sandbox-db-1'].cpu };
}

function startSampler(container) {
  const samples = [];
  let running = true;
  const done = (async () => {
    await sleep(2000); // laisse k6 démarrer
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
      cpu_max: samples.length ? Math.max(...samples.map((s) => s.cpu)) : 0,
      db_cpu_avg: avg(samples.map((s) => s.db_cpu)),
      mem_peak_mib: samples.length ? Math.max(...samples.map((s) => s.mem)) : 0,
    };
  };
}

const resetDb = () => sh('docker compose exec -T db psql -q -U stock -d stock -f /reset.sql');

async function k6(lang, scenario, vus, duration, out) {
  const outArg = out ? `-e OUT=/bench/${RES}/raw/${out}.json` : '';
  await sh(`docker compose run --rm -e TARGET=http://${lang}:8080 -e SCENARIO=${scenario} -e VUS=${vus} -e DURATION=${duration} ${outArg} k6 run --quiet --no-color load.js`)
    .catch((e) => log(`  k6 a signalé des seuils/erreurs (${e.code})`));
}

async function benchLang(lang) {
  const container = `sandbox-${lang}-1`;
  const result = { lang, tests: {} };
  await sh(`docker compose rm -sf ${lang}`).catch(() => {});
  await resetDb();
  result.image_mb = Number(await sh(`docker image inspect sandbox-${lang} --format "{{.Size}}"`)) / 1048576;

  log(`[${lang}] démarrage`);
  const t0 = performance.now();
  await sh(`docker compose up -d --no-build ${lang}`);
  for (;;) {
    try { if ((await fetch(`http://localhost:${PORTS[lang]}/health`)).ok) break; } catch { /* pas encore prêt */ }
    await sleep(25);
  }
  result.startup_ms = Math.round(performance.now() - t0);
  await sleep(3000);
  result.idle_mem_mib = (await sampleStats(container)).mem;
  log(`[${lang}] prêt en ${result.startup_ms} ms, ${result.idle_mem_mib.toFixed(1)} MiB au repos — chauffe`);

  await k6(lang, 'mixed', 50, '15s');

  for (const t of TESTS) {
    await resetDb();
    log(`[${lang}] ${t.name} (${t.vus} VUs, ${DURATION})`);
    const stop = startSampler(container);
    // Le sampler s'arrête 2 s avant k6 pour ne pas mesurer la phase d'arrêt
    const k6run = k6(lang, t.scenario, t.vus, DURATION, `${lang}-${t.name}`);
    await sleep(parseInt(DURATION) * 1000 + 1000);
    const res = await stop();
    await k6run;
    const d = JSON.parse(readFileSync(`bench/${RES}/raw/${lang}-${t.name}.json`, 'utf8')).metrics;
    const dur = d.http_req_duration.values;
    result.tests[t.name] = {
      rps: d.http_reqs.values.rate,
      p50: dur.med, p95: dur['p(95)'], p99: dur['p(99)'], max: dur.max,
      errors: d.http_req_failed?.values.rate ?? 0,
      ...res,
    };
    log(`  ${result.tests[t.name].rps.toFixed(0)} req/s, p99 ${dur['p(99)'].toFixed(1)} ms, CPU ${res.cpu_avg.toFixed(0)} % (db ${res.db_cpu_avg.toFixed(0)} %), RAM max ${res.mem_peak_mib.toFixed(0)} MiB`);
  }

  const [oom, restarts] = (await sh(`docker inspect --format "{{.State.OOMKilled}} {{.RestartCount}}" ${container}`)).split(' ');
  result.oom_killed = oom === 'true';
  result.restarts = Number(restarts);
  await sh(`docker compose rm -sf ${lang}`);
  return result;
}

const all = [];
for (const lang of langs) all.push(await benchLang(lang));

let prev = {};
try { prev = JSON.parse(readFileSync(`bench/${RES}/results.json`, 'utf8')); } catch { /* premier run */ }
for (const r of all) prev[r.lang] = { ...r, date: new Date().toISOString(), duration: DURATION, app_cpus: Number(APP_CPUS) };
writeFileSync(`bench/${RES}/results.json`, JSON.stringify(prev, null, 2));

const f = (n, d = 0) => n.toFixed(d);
let md = `# Résultats\n\nConteneur app : ${APP_CPUS} vCPU, 512 Mo. Postgres commun : 3 vCPU, 2 Go. Durée par test : ${DURATION}.\n\n`;
md += '| Langage | Image (Mo) | Démarrage (ms) | RAM repos (MiB) | OOM | Redémarrages |\n|---|---:|---:|---:|---|---:|\n';
for (const r of Object.values(prev)) md += `| ${r.lang} | ${f(r.image_mb, 1)} | ${r.startup_ms} | ${f(r.idle_mem_mib, 1)} | ${r.oom_killed ? 'oui' : 'non'} | ${r.restarts} |\n`;
for (const t of TESTS) {
  md += `\n## ${t.name} (${t.vus} VUs)\n\n| Langage | req/s | p50 (ms) | p95 (ms) | p99 (ms) | Erreurs | CPU app (%) | CPU db (%) | RAM max (MiB) |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const r of Object.values(prev)) {
    const x = r.tests[t.name];
    if (x) md += `| ${r.lang} | ${f(x.rps)} | ${f(x.p50, 2)} | ${f(x.p95, 2)} | ${f(x.p99, 2)} | ${f(x.errors * 100, 2)} % | ${f(x.cpu_avg)} | ${f(x.db_cpu_avg ?? 0)} | ${f(x.mem_peak_mib)} |\n`;
  }
}
writeFileSync(`bench/${RES}/RESULTS.md`, md);
log(`Terminé : bench/${RES}/RESULTS.md`);
