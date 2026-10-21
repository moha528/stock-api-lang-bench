# Stock API — Rust

- **Pile** : axum 0.8 (hyper 1, HTTP/1 seul, features par défaut désactivées), tokio 1.54, tokio-postgres 0.7 + deadpool-postgres 0.14, serde / serde_json, allocateur mimalloc.
- **Runtime tokio `current_thread`** : le conteneur n'a qu'un vCPU ; un seul thread évite le vol de tâches, les synchronisations inter-threads et le throttling CFS qu'un pool de N workers (N = cœurs de l'hôte) provoquerait sous un quota de 1 CPU.
- **Postgres** : requêtes préparées en cache par connexion (`prepare_typed_cached`, types de paramètres explicites), pool de `DB_POOL_MAX` connexions, recyclage `Fast` (aucune requête de contrôle à l'emprunt), TCP_NODELAY côté driver et côté serveur HTTP.
- **JSON** : les lignes sont sérialisées directement depuis le buffer du driver (pas de `String` intermédiaire), buffer de sortie pré-dimensionné, réponses d'erreur en octets statiques ; parsing du corps avec emprunt (`Cow<str>`).
- **Build** : profil release `opt-level=3`, `lto="fat"`, `codegen-units=1`, `panic="abort"`, `strip=true`.
- **Image** : Dockerfile multi-étapes (couche de dépendances mise en cache via un `main` factice), image finale `distroless/cc-debian13:nonroot` (glibc, plus rapide que musl pour memcpy et les routines de chaînes).
- **Traitements lourds `/cpu/*`** ([src/heavy.rs](src/heavy.rs), SPEC-heavy.md) : jamais sur le runtime tokio ; chaque requête part sur un `rayon::ThreadPool` dédié de `available_parallelism()` workers (quota cgroup, taille loguée au démarrage, file non bornée), réponse par `tokio::sync::oneshot`. Parsing et sérialisation se font aussi sur le worker.
- **hash** : sha2 0.11, compression SHA-NI détectée à l'exécution (cpufeatures) ; chaque message tient dans un bloc, le padding est posé une fois et seule `compress256` tourne à chaque tour. **montecarlo** : f64 strict, Rust ne contracte jamais en FMA ni ne réassocie, résultat bit à bit celui de la référence.
- **reconcile / sort** : une `String` du tas par référence ou chaîne, `Vec` et `HashMap` pré-dimensionnés, hasher foldhash, relevé mélangé sous forme (indice, montant) ; `sort_unstable_by` avec comparaison des 8 premiers octets en un `u64` big-endian (même ordre que les octets).
- **commissions** : corps jusqu'à 16 Mo (`DefaultBodyLimit`), parsing serde zéro-copie (`Cow<str>` empruntés au corps) avec regroupement par agent au fil du parsing (visiteur serde), JSON écrit à la main dans un buffer (itoa, ryu).
- **CPU cible** : `x86-64-v3` (`.cargo/config.toml`, cible Linux x86_64 seulement) : AVX2/BMI2, présents sur tout x86 depuis 2013-2017 et toutes les VM cloud courantes ; pas `native` pour que l'image tourne ailleurs.
- Arrêt propre sur SIGTERM (`with_graceful_shutdown`), aucun log par requête, aucun middleware.
