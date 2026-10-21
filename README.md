# Stock API Bench : Node.js, Rust, Go, Java

Une même API de gestion de stock, écrite quatre fois avec la pile la plus rapide de chaque écosystème, mesurée sur une machine légère simulée. Le but est de comparer des langages à application strictement identique : même SQL, mêmes JSON, mêmes codes HTTP, mêmes limites de conteneur. Seule la pile technique change.

| Langage | Pile |
|---|---|
| Rust | axum 0.8, tokio (current_thread), tokio-postgres + deadpool, mimalloc, LTO |
| Go | Go 1.27, fasthttp, pgx v5 (pgxpool), image `scratch` |
| Java | JDK 25, Vert.x 5, client Postgres pipeliné, SerialGC, cache AOT, JRE jlink |
| Node.js | Node 24, uWebSockets.js, postgres.js, image distroless |

Le contrat est dans [SPEC.md](SPEC.md). Les quatre implémentations passent le même [contract test](contract-test.mjs) (31 vérifications).

## Résultats

Chaque app tourne seule dans un conteneur limité à 512 Mo, face à un PostgreSQL 17 commun (3 vCPU, 2 Go). La charge vient de k6, en boucle fermée, 20 s par test après 15 s de chauffe. Aucune erreur et aucun OOM sur aucun test.

### Run 1 : app à 1 vCPU, Postgres est le goulot

Postgres tourne à environ 275 % sur 300 pour Rust, Go et Java : leurs chiffres sont plafonnés par la base.

| Test (req/s) | Rust | Go | Java | Node.js |
|---|---:|---:|---:|---:|
| Lecture par id (100 VUs) | 30 157 | 22 517 | **33 183** | 9 457 |
| Liste de 100 produits | 8 703 | 8 420 | **10 307** | 3 317 |
| Mouvement de stock | 12 387 | 12 378 | **15 496** | 5 368 |
| Mix, 10 VUs | **13 366** | 13 225 | 8 786 | 3 495 |
| Mix, 100 VUs | 18 086 | 17 704 | **22 302** | 4 286 |
| Mix, 500 VUs | 17 945 | 17 247 | **21 181** | 4 166 |

### Run 2 : app à 0,5 vCPU, l'app est le goulot

Postgres reste sous 76 % de son quota et les quatre apps saturent leur CPU. Ce run mesure l'efficacité du langage et de sa pile.

| Test (req/s) | Rust | Go | Java | Node.js |
|---|---:|---:|---:|---:|
| Lecture par id (100 VUs) | **14 874** | 10 042 | 13 122 | 6 133 |
| Liste de 100 produits | **6 371** | 6 267 | 4 688 | 1 718 |
| Mouvement de stock | **10 266** | 6 905 | 10 077 | 3 471 |
| Mix, 10 VUs | **9 884** | 5 988 | 7 822 | 2 160 |
| Mix, 100 VUs | 12 338 | 8 919 | **13 280** | 2 934 |
| Mix, 500 VUs | 11 245 | 7 694 | **12 499** | 2 869 |

### Ressources

| | Rust | Go | Java | Node.js |
|---|---:|---:|---:|---:|
| Image | 43 Mo | **14 Mo** | 173 Mo | 215 Mo |
| RAM au repos | 7 Mo | **3 Mo** | 55 Mo | 27 Mo |
| RAM max en charge | **34 Mo** | 71 Mo | 180 Mo | 105 Mo |

Le détail de chaque test (latences p50, p95 et p99, CPU de l'app et de Postgres, RAM) est dans [bench/results/RESULTS.md](bench/results/RESULTS.md) et [bench/results-0.5cpu/RESULTS.md](bench/results-0.5cpu/RESULTS.md).

## Ce qu'on en retient

- **Rust a le coût unitaire le plus bas.** Il consomme le moins de CPU par requête, garde la latence la plus stable (p99 de 6 ms à faible charge, contre plus de 50 ms pour Go et Node.js à 0,5 vCPU) et la plus petite empreinte mémoire. Il gagne là où chaque traitement compte en lui-même.
- **Java gagne sur le volume.** Sous forte concurrence, son client Postgres pipeliné regroupe plusieurs requêtes par aller-retour et amortit le coût de chacune. Il passe alors devant Rust. Le prix est une RAM 5 à 10 fois plus élevée.
- **Quand la base sature, le langage ne compte plus.** Au run 1, Rust, Go et Java plafonnent ensemble. Optimiser le langage d'un code qui attend la base ne rapporte rien.
- **Go** reste le plus léger en image et en RAM au repos, mais fait environ 30 % de moins que Rust par vCPU dès que le CPU manque.
- **Node.js** est 3 à 4 fois sous les autres et le seul limité par son propre CPU dès le premier run.

## Limites

- Une seule passe par configuration, sur une seule machine (Windows 11, Docker Desktop sous WSL2, 8 cœurs). k6, Postgres et l'app partagent la même machine. Un écart de moins de 3 % ne départage personne.
- Le quota CPU est un quota CFS, pas un cpuset : le conteneur voit tous les cœurs de l'hôte.
- Les requêtes testées sont légères et dominées par la base. Aucun traitement lourd en CPU (calcul, PDF, chiffrement) n'est encore mesuré.
- Le démarrage mesuré inclut la création du conteneur par Docker.

## Reproduire

Prérequis : Docker avec Compose v2 et Node.js 24 (pour le contract test et l'orchestrateur). Aucun toolchain Rust, Go ou Java n'est nécessaire : tout se compile dans Docker.

```bash
docker compose up -d db
docker compose build node rust go java
node bench/run.mjs
```

Un seul langage : `node bench/run.mjs rust`. Variables utiles :

- `BENCH_DURATION` : durée de chaque test, `20s` par défaut.
- `APP_CPUS` : quota CPU des apps, `1.0` par défaut. Le run 2 utilise `0.5`.
- `BENCH_OUT` : dossier de résultats sous `bench/`, `results` par défaut.

Vérifier qu'une implémentation respecte le contrat :

```bash
docker compose up -d rust
node contract-test.mjs http://localhost:8082
```

Ports : Node.js 8081, Rust 8082, Go 8083, Java 8084.

## Structure

```
SPEC.md              contrat commun : endpoints, SQL exact, JSON, erreurs
contract-test.mjs    vérification du contrat contre une implémentation
docker-compose.yml   Postgres + les 4 apps + k6
db/                  schéma, données initiales, remise à zéro
bench/load.js        scénarios k6
bench/run.mjs        orchestrateur : démarrage, chauffe, tests, CPU et RAM
bench/results*/      résultats publiés
node/ rust/ go/ java/  les implémentations
```

## Contribuer

Le banc est fait pour être étendu. Toute contribution doit garder la règle de base : application identique, seule la pile change.

**Ajouter un scénario de test**

1. Ajoute sa fonction dans [bench/load.js](bench/load.js), avec un tag `name` pour grouper les URL.
2. Ajoute-le à la liste `TESTS` de [bench/run.mjs](bench/run.mjs).
3. S'il faut un nouvel endpoint, décris-le d'abord dans [SPEC.md](SPEC.md), avec son SQL exact, ajoute ses cas au contract test, puis implémente-le dans les quatre langages.

**Ajouter un langage ou une autre pile**

1. Crée son dossier avec un `Dockerfile` multi-étapes qui écoute sur `PORT`.
2. Ajoute son service dans `docker-compose.yml`, avec l'ancre `*app` et un port libre.
3. Ajoute-le à `PORTS` dans `bench/run.mjs` et fais passer le contract test.

**Pistes ouvertes**

- Traitements lourds en CPU : génération de PDF, hachage, compression, parsing de gros fichiers.
- Traitements en lot : insertions groupées, imports massifs.
- Démarrage à froid et courbe de chauffe du JIT.
- Plusieurs passes avec intervalle de variation.
- Autres machines : ARM, vrai VPS, cpuset au lieu d'un quota.
- Autres piles : Spring Boot, GraalVM native-image, Bun, Deno, Actix, net/http.

Quand tu publies des résultats, joins la machine, les versions et le `RESULTS.md` produit.

## Licence

[MIT](LICENSE)
