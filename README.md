# stock-api-lang-bench

## Overview

The same inventory API is implemented four times, in Node.js, Rust, Go and Java, each with the fastest stack available in its ecosystem. Each implementation is measured on a simulated small machine. The SQL, the JSON, the HTTP status codes and the container limits are identical; only the language and its runtime stack change.

A second part compares Rust and Java on five CPU-bound workloads that do not touch the database.

## Problem

Language comparisons often rely on applications that differ in more than the language: other queries, other features, other resource limits. This benchmark fixes everything except the stack, so that the differences it measures can be attributed to the stack. It also states what a single run on a single machine cannot show.

## Approach / Architecture

**A common contract.** [SPEC.md](SPEC.md) defines the endpoints, the exact SQL of each query (as prepared statements), the JSON bodies and the error codes:

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness, no database access |
| `GET /products?limit&offset` | paginated list |
| `GET /products/{id}` | read by id |
| `POST /products` | create, `409` on duplicate SKU |
| `POST /products/{id}/movements` | atomic stock movement, `409` on insufficient stock |
| `GET /stats` | aggregate count, quantity and value |

A stock movement is a single SQL statement: a CTE updates the quantity only if it stays non-negative and inserts the movement in the same statement. Every implementation passes the same [contract test](contract-test.mjs) (31 checks).

**Identical structure.** Each implementation has one module for HTTP routing, one for data access and one entry point that reads the configuration and creates the connection pool (20 connections for all). None has an application cache, per-request logging or extra middleware. Each builds in a multi-stage Docker image and shuts down cleanly on `SIGTERM`.

| Language | Stack |
|---|---|
| Rust | axum 0.8, tokio (`current_thread` runtime), tokio-postgres with deadpool, mimalloc, fat LTO, rayon pool for CPU work |
| Go | Go 1.27, fasthttp, pgx v5 (pgxpool), `scratch` image |
| Java | JDK 25, Vert.x 5, pipelined Postgres client, SerialGC at 1 CPU and ParallelGC above, AOT cache, jlink runtime |
| Node.js | Node 24, uWebSockets.js, postgres.js, distroless image |

**Load generation.** k6 runs in a closed loop: 15 s of warm-up, then 20 s per test. The orchestrator ([bench/run.mjs](bench/run.mjs)) starts each application alone and records the CPU and memory of both the application and PostgreSQL.

**CPU-bound workloads (Rust and Java).** [SPEC-heavy.md](SPEC-heavy.md) defines five deterministic endpoints:

| Workload | What it computes | What it stands for |
|---|---|---|
| `hash` | 200,000 rounds of SHA-256 | signatures, key derivation |
| `montecarlo` | 20,000 paths × 252 steps | pricing, risk |
| `reconcile` | matching of 100,000 payments | strings, hash tables, allocation |
| `sort` | sorting of 100,000 strings | exports, deduplication |
| `commissions` | JSON batch of 20,000 lines (1.2 MB) | parsing, grouping, serialisation |

Input data comes from a shared pseudo-random generator (splitmix64). Both languages must return exactly the result of a JavaScript reference implementation, which [heavy-check.mjs](heavy-check.mjs) verifies. The work runs on a fixed pool of workers sized to the CPU quota, never on the I/O event loop. Each workload is measured on a fresh container in four phases: cold (first 30 requests, one at a time), single request after warm-up, throughput (twice as many concurrent requests as vCPUs) and overload (64 concurrent requests).

## Tech stack

Rust, Go, Java, JavaScript (Node.js) · PostgreSQL 17 · Docker Compose · k6 · Node.js orchestration scripts.

## How to run

Requirements: Docker with Compose v2, and Node.js 24 for the contract test and the orchestrator. No Rust, Go or Java toolchain is needed: everything compiles inside Docker.

```bash
docker compose up -d db
docker compose build node rust go java
node bench/run.mjs
```

A single language: `node bench/run.mjs rust`. Useful variables:

- `BENCH_DURATION`: duration of each test, `20s` by default.
- `APP_CPUS`: CPU quota of the applications, `1.0` by default. Run 2 uses `0.5`.
- `BENCH_OUT`: result directory under `bench/`, `results` by default.

Check that an implementation respects the contract:

```bash
docker compose up -d rust
node contract-test.mjs http://localhost:8082
```

CPU-bound workloads, Rust against Java (`APP_CPUS` sets the quota, `--only=hash,sort` restricts the workloads):

```bash
node heavy-check.mjs http://localhost:8082
node bench/heavy-run.mjs rust java
```

Ports: Node.js 8081, Rust 8082, Go 8083, Java 8084.

## Results

Each application runs alone in a container limited to 512 MB, against a shared PostgreSQL 17 (3 vCPU, 2 GB). No test produced an error or an out-of-memory kill.

**Run 1: application at 1 vCPU, PostgreSQL is the bottleneck.** PostgreSQL runs at about 275 % of its 300 % quota for Rust, Go and Java, so their figures are capped by the database.

| Test (req/s) | Rust | Go | Java | Node.js |
|---|---:|---:|---:|---:|
| Read by id (100 VUs) | 30,157 | 22,517 | **33,183** | 9,457 |
| List of 100 products | 8,703 | 8,420 | **10,307** | 3,317 |
| Stock movement | 12,387 | 12,378 | **15,496** | 5,368 |
| Mix, 10 VUs | **13,366** | 13,225 | 8,786 | 3,495 |
| Mix, 100 VUs | 18,086 | 17,704 | **22,302** | 4,286 |
| Mix, 500 VUs | 17,945 | 17,247 | **21,181** | 4,166 |

**Run 2: application at 0.5 vCPU, the application is the bottleneck.** PostgreSQL stays below 76 % of its quota and all four applications saturate their CPU, so this run measures the efficiency of each stack.

| Test (req/s) | Rust | Go | Java | Node.js |
|---|---:|---:|---:|---:|
| Read by id (100 VUs) | **14,874** | 10,042 | 13,122 | 6,133 |
| List of 100 products | **6,371** | 6,267 | 4,688 | 1,718 |
| Stock movement | **10,266** | 6,905 | 10,077 | 3,471 |
| Mix, 10 VUs | **9,884** | 5,988 | 7,822 | 2,160 |
| Mix, 100 VUs | 12,338 | 8,919 | **13,280** | 2,934 |
| Mix, 500 VUs | 11,245 | 7,694 | **12,499** | 2,869 |

**Resources.**

| | Rust | Go | Java | Node.js |
|---|---:|---:|---:|---:|
| Image | 43 MB | **14 MB** | 173 MB | 215 MB |
| RAM at rest | 7 MB | **3 MB** | 55 MB | 27 MB |
| Peak RAM under load | **34 MB** | 71 MB | 180 MB | 105 MB |

**CPU-bound workloads, throughput at full load (req/s, Rust / Java).**

| Workload | 1 vCPU | 4 vCPU |
|---|---|---|
| String sort | **89** / 27 (×3.3) | **359** / 108 (×3.3) |
| Iterated SHA-256 | **89** / 63 (×1.4) | **360** / 285 (×1.26) |
| Payment reconciliation | **125** / 98 (×1.28) | **391** / 339 (×1.16) |
| Monte Carlo | **94** / 74 (×1.27) | **424** / 371 (×1.14) |
| Commissions (JSON batch) | **224** / 210 (×1.06) | **892** / 602 (×1.48) |

**Cold start at 1 vCPU, first request (Rust / Java):** reconciliation 17 / 370 ms, hash 12 / 143 ms, sort 13 / 86 ms, Monte Carlo 10 / 21 ms, commissions 196 / 98 ms. The 196 ms for Rust on commissions is an isolated case: the same measurement at 4 vCPU gives 9 ms. After 30 requests at 1 vCPU, Java reconciliation is still 5 to 7 times slower than in its warm state; at 4 vCPU Java warms up in about ten requests.

**Peak RAM:** Rust stays between 10 and 36 MB on four of the five workloads, against 65 to 330 MB for Java. On commissions, Rust reaches 166–231 MB and Java 375–447 MB.

Per-test details (p50, p95 and p99 latency, application and PostgreSQL CPU, memory) are in [bench/results/RESULTS.md](bench/results/RESULTS.md), [bench/results-0.5cpu/RESULTS.md](bench/results-0.5cpu/RESULTS.md), [bench/results-heavy/cpu-1/RESULTS.md](bench/results-heavy/cpu-1/RESULTS.md) and [bench/results-heavy/cpu-4/RESULTS.md](bench/results-heavy/cpu-4/RESULTS.md).

**Observations.**

- Rust has the lowest cost per request: the least CPU per request, the most stable latency (p99 of 6 ms at low load, against more than 50 ms for Go and Node.js at 0.5 vCPU) and the smallest memory footprint.
- Under high concurrency on the database-bound API, Java's pipelined Postgres client batches several queries per round trip and overtakes Rust, at the cost of 5 to 10 times more memory.
- On the CPU-bound workloads, Rust is ahead on all five, at 1 and at 4 vCPU: 6 to 48 % more throughput, three times more on string sorting, no warm-up and 3 to 10 times less memory. The gap narrows at 4 vCPU on floating-point work, where Java's JIT and garbage collector have spare cores.
- When the database saturates (run 1), Rust, Go and Java reach the same ceiling: optimising the language of code that waits on the database brings nothing.
- Go has the smallest image and the lowest memory at rest, but delivers about 30 % less than Rust per vCPU once CPU is scarce.
- Node.js is 3 to 4 times below the others and is the only one limited by its own CPU from run 1 onward.

**Limitations.**

- One pass per configuration, on one machine (Windows 11, Docker Desktop on WSL2, 8 cores); k6, PostgreSQL and the application share that machine. A difference below 3 % does not separate two stacks.
- The CPU quota is a CFS quota, not a cpuset: the container sees all host cores.
- The API queries are light and dominated by the database. The CPU-bound workloads do not cover PDF generation, compression or image processing.
- Each CPU-bound implementation uses a legitimate shortcut: Rust calls the SHA-256 compression function directly and compares strings 8 bytes at a time while sorting; Java shares the `String` object between payment and statement. Part of the gap on hashing and sorting therefore comes from the low-level access Rust allows.
- The measured start-up time includes container creation by Docker.

## Contributing

The rule for any contribution is unchanged: the application stays identical and only the stack changes. A new endpoint is first specified in [SPEC.md](SPEC.md) with its exact SQL and added to the contract test, then implemented in all four languages. A new stack needs a multi-stage `Dockerfile` listening on `PORT`, a service in `docker-compose.yml` and an entry in `PORTS` in `bench/run.mjs`, and must pass the contract test. When publishing results, include the machine, the versions and the generated `RESULTS.md`.

Open directions: more CPU-bound workloads (PDF, compression, images, large-file parsing); the CPU-bound workloads in Go and Node.js; idiomatic variants next to the optimised ones, to separate the effect of the language from that of low-level access; batch work mixing computation and database; GraalVM native image against the JVM for cold start; several passes with a variation interval; other machines (ARM, a real VPS, cpuset instead of a quota); other stacks (Spring Boot, Bun, Deno, Actix, net/http).

## License

[MIT](LICENSE)
