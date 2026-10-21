# Stock API, version Go

- **Pile** : Go 1.27.3, `fasthttp` v1.76.0, `pgx/v5` v5.11.0 + `pgxpool`, `encoding/json/v2` (stdlib) pour décoder les corps.
- **Pourquoi fasthttp** : sur 1 vCPU c'est le CPU de l'app qui limite, et fasthttp n'alloue presque rien par requête (contextes et tampons réutilisés, pool de workers), là où `net/http` crée `Request`, maps d'en-têtes et `bufio` à chaque appel.
- **Routage** : un `switch` sur le chemin (6 routes), sans routeur tiers ni middleware, et aucun log par requête.
- **Postgres** : `QueryExecModeCacheStatement` (requêtes préparées en cache par connexion, résultats binaires), pool de `DB_POOL_MAX` connexions.
- **JSON en sortie** : sérialisation directe des octets bruts renvoyés par Postgres (`RawValues`) dans un tampon issu d'un `sync.Pool`. Il n'y a ni struct intermédiaire ni chaîne allouée par ligne, et l'échappement est identique à `JSON.stringify`.
- **JSON en entrée** : `encoding/json/v2` est strict (types exacts, UTF-8 valide) et accepte les doublons de clés, comme `JSON.parse`.
- **Runtime** : `GOMAXPROCS` suit le quota cgroup (1 vCPU) nativement. `GOMEMLIMIT=400MiB` reste sous les 512 Mo et `GOGC=200` espace les GC, le tas vivant étant minuscule.
- **Image** : build multi-étapes, `CGO_ENABLED=0 -trimpath -ldflags="-s -w"`, image finale `scratch` (binaire seul) exécutée en utilisateur non-root.
- **Arrêt** : sur SIGTERM, fasthttp arrête proprement (`ShutdownWithContext`, 10 s) puis le pool se ferme.
