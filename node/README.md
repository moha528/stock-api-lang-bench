# Stock API — Node.js

- **Pile** : Node 24 + `uWebSockets.js` 20.71.0 (HTTP) + `postgres` 3.4.9 (porsager). Sur 1 vCPU, uWS (pile HTTP native C++, sans les streams de `node:http`) donne le meilleur débit de l'écosystème Node ; `postgres` est le driver JS pur le plus rapide (pipelining, statements préparés mis en cache par connexion).
- **Structure** : `src/index.js` (config, pool, écoute, SIGTERM), `src/router.js` (routes et validation), `src/db.js` (le SQL exact de SPEC.md).
- **Requêtes préparées** partout (`prepare: true`, protocole étendu forcé même pour `/stats`), pool de `DB_POOL_MAX` connexions, `fetch_types: false` (aucune requête de types à chaque connexion).
- **`int8` → nombre JSON** via un type personnalisé (oid 20) ; `/stats` est lu par position (colonnes anonymes).
- **Chemin chaud** : réponses d'erreur constantes gardées en chaînes, JSON écrit à la main pour `/stats` et les mouvements, écritures groupées par `res.cork`, corps court lu sans copie, ni logs ni middleware.
- **Image** : build multi-étapes ; seul le binaire uWS de l'arch/ABI cible est conservé ; runtime `distroless/nodejs24-debian13:nonroot` (uWS exige glibc ≥ 2.38, donc pas d'Alpine).
- **Runtime 512 Mo** : `NODE_OPTIONS=--max-old-space-size=384 --max-semi-space-size=16` (tas plafonné, young-gen élargie pour les allocations par requête).
- **Arrêt** : sur SIGTERM, fermeture du socket d'écoute, `sql.end()` (les requêtes en cours se terminent), puis `app.close()` et sortie 0.
