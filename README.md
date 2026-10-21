# Stock API Bench : Node.js, Rust, Go, Java

Une même API de gestion de stock, écrite quatre fois avec la pile la plus rapide de chaque écosystème, mesurée sur une machine légère simulée. Le but est de comparer des langages à application strictement identique : même SQL, mêmes JSON, mêmes codes HTTP, mêmes limites de conteneur. Seule la pile technique change.

| Langage | Pile |
|---|---|
| Rust | axum 0.8, tokio (current_thread), tokio-postgres + deadpool, mimalloc, LTO, pool rayon pour le calcul lourd |
| Go | Go 1.27, fasthttp, pgx v5 (pgxpool), image `scratch` |
| Java | JDK 25, Vert.x 5, client Postgres pipeliné, SerialGC à 1 CPU et ParallelGC au-delà, cache AOT, JRE jlink |
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

## Traitements lourds : Rust contre Java

Second volet, limité à Rust et Java. Il comprend cinq traitements métier lourds en CPU, sans base de données, décrits dans [SPEC-heavy.md](SPEC-heavy.md) :

| Traitement | Ce qu'il fait | Ce qu'il simule |
|---|---|---|
| `hash` | 200 000 tours de SHA-256 | signatures, dérivation de clés |
| `montecarlo` | 20 000 chemins × 252 pas | tarification, risque |
| `reconcile` | rapprochement de 100 000 paiements | chaînes, table de hachage, allocations |
| `sort` | tri de 100 000 chaînes | exports, dédoublonnage |
| `commissions` | lot JSON de 20 000 lignes (1,2 Mo) | parsing, regroupement, sérialisation |

Les données sont générées par un générateur pseudo-aléatoire commun (splitmix64). Les deux langages rendent exactement le même résultat, vérifié par [heavy-check.mjs](heavy-check.mjs) contre la référence [heavy-reference.mjs](heavy-reference.mjs). Le travail tourne sur un pool de workers de la taille du quota CPU, jamais sur la boucle d'I/O.

Chaque traitement est mesuré sur un conteneur neuf, en quatre temps :

1. **froid** : les 30 premières requêtes, une à la fois ;
2. **unitaire** : une requête à la fois, après chauffe ;
3. **débit** : deux fois plus de requêtes simultanées que de vCPU ;
4. **surcharge** : 64 requêtes simultanées.

Débit à pleine charge, en req/s (Rust / Java) :

| Traitement | 1 vCPU | 4 vCPU |
|---|---|---|
| Tri de chaînes | **89** / 27 (×3,3) | **359** / 108 (×3,3) |
| SHA-256 itéré | **89** / 63 (×1,4) | **360** / 285 (×1,26) |
| Rapprochement de paiements | **125** / 98 (×1,28) | **391** / 339 (×1,16) |
| Monte-Carlo | **94** / 74 (×1,27) | **424** / 371 (×1,14) |
| Commissions (lot JSON) | **224** / 210 (×1,06) | **892** / 602 (×1,48) |

Démarrage à froid à 1 vCPU, première requête (Rust / Java) :

| Traitement | Rust | Java |
|---|---:|---:|
| Rapprochement | 17 ms | 370 ms |
| Hash | 12 ms | 143 ms |
| Tri | 13 ms | 86 ms |
| Monte-Carlo | 10 ms | 21 ms |
| Commissions | 196 ms | 98 ms |

Le 196 ms de Rust sur les commissions est un cas isolé : la même mesure à 4 vCPU donne 9 ms. Après 30 requêtes à 1 vCPU, le rapprochement Java reste encore 5 à 7 fois au-dessus de son régime chaud. À 4 vCPU, Java chauffe en une dizaine de requêtes.

RAM maximale : Rust tient entre 10 et 36 Mo sur 4 traitements sur 5, contre 65 à 330 Mo pour Java. Sur les commissions, Rust monte à 166-231 Mo et Java à 375-447 Mo.

Le détail est dans [bench/results-heavy/cpu-1/RESULTS.md](bench/results-heavy/cpu-1/RESULTS.md) et [bench/results-heavy/cpu-4/RESULTS.md](bench/results-heavy/cpu-4/RESULTS.md). Les `results.json` contiennent la durée de chacune des 30 premières requêtes.

## Ce qu'on en retient

- **Rust a le coût unitaire le plus bas.** Il consomme le moins de CPU par requête, garde la latence la plus stable (p99 de 6 ms à faible charge, contre plus de 50 ms pour Go et Node.js à 0,5 vCPU) et la plus petite empreinte mémoire. Il gagne là où chaque traitement compte en lui-même.
- **Java gagne sur le volume quand il y a des entrées-sorties à regrouper.** Sous forte concurrence, son client Postgres pipeliné regroupe plusieurs requêtes par aller-retour et amortit le coût de chacune. Il passe alors devant Rust sur l'API stock. Le prix est une RAM 5 à 10 fois plus élevée.
- **Sur du calcul lourd, Rust gagne toujours.** Il gagne les cinq traitements lourds, à 1 comme à 4 vCPU :
  - de 6 à 48 % de débit en plus, et trois fois plus sur le tri de chaînes ;
  - aucune chauffe, et 3 à 10 fois moins de RAM.

  L'écart se resserre à 4 vCPU sur le calcul flottant, parce que le JIT et le GC de Java y ont des cœurs libres. Sur un seul vCPU, la chauffe de la JVM coûte cher.
- **Quand la base sature, le langage ne compte plus.** Au run 1, Rust, Go et Java plafonnent ensemble. Optimiser le langage d'un code qui attend la base ne rapporte rien.
- **Go** reste le plus léger en image et en RAM au repos, mais fait environ 30 % de moins que Rust par vCPU dès que le CPU manque.
- **Node.js** est 3 à 4 fois sous les autres et le seul limité par son propre CPU dès le premier run.

## Limites

- Une seule passe par configuration, sur une seule machine (Windows 11, Docker Desktop sous WSL2, 8 cœurs). k6, Postgres et l'app partagent la même machine. Un écart de moins de 3 % ne départage personne.
- Le quota CPU est un quota CFS, pas un cpuset : le conteneur voit tous les cœurs de l'hôte.
- Les requêtes de l'API stock sont légères et dominées par la base. Les traitements lourds ne couvrent ni la génération de PDF, ni la compression, ni le traitement d'images.
- Chaque implémentation lourde a un raccourci légitime :
  - Rust appelle directement la compression SHA-256 ;
  - Rust compare les chaînes 8 octets à la fois pendant le tri ;
  - Java partage l'objet `String` entre paiement et relevé.

  Une partie de l'écart sur le hash et le tri vient donc de l'accès bas niveau que Rust permet.
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

Traitements lourds, Rust contre Java (`APP_CPUS` fixe le quota, `--only=hash,sort` limite les traitements) :

```bash
node heavy-check.mjs http://localhost:8082
node bench/heavy-run.mjs rust java
```

Ports : Node.js 8081, Rust 8082, Go 8083, Java 8084.

## Structure

```
SPEC.md              contrat commun : endpoints, SQL exact, JSON, erreurs
contract-test.mjs    vérification du contrat contre une implémentation
SPEC-heavy.md        contrat des traitements lourds (Rust et Java)
heavy-reference.mjs  implémentation de référence des traitements lourds
heavy-check.mjs      vérification des traitements lourds contre la référence
docker-compose.yml   Postgres + les 4 apps + k6
db/                  schéma, données initiales, remise à zéro
bench/load.js        scénarios k6
bench/run.mjs        orchestrateur : démarrage, chauffe, tests, CPU et RAM
bench/heavy.js       scénarios k6 des traitements lourds
bench/heavy-run.mjs  orchestrateur des traitements lourds : froid, unitaire, débit, surcharge
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

- D'autres traitements lourds : génération de PDF, compression, images, parsing de gros fichiers.
- Les traitements lourds en Go et en Node.js.
- La variante idiomatique de chaque traitement à côté de la variante optimisée (API `Sha256` standard en Rust, tri sans comparaison sur 8 octets), pour séparer l'effet du langage de celui de l'accès bas niveau.
- Traitements en lot qui mêlent calcul et base : insertions groupées, imports massifs.
- GraalVM native-image contre JVM sur le démarrage à froid.
- Plusieurs passes avec intervalle de variation.
- Autres machines : ARM, vrai VPS, cpuset au lieu d'un quota.
- Autres piles : Spring Boot, Bun, Deno, Actix, net/http.

Quand tu publies des résultats, joins la machine, les versions et le `RESULTS.md` produit.

## Licence

[MIT](LICENSE)
