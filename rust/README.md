# Stock API — Rust

- **Pile** : axum 0.8 (hyper 1, HTTP/1 seul, features par défaut désactivées), tokio 1.54, tokio-postgres 0.7 + deadpool-postgres 0.14, serde / serde_json, allocateur mimalloc.
- **Runtime tokio `current_thread`** : le conteneur n'a qu'un vCPU ; un seul thread évite le vol de tâches, les synchronisations inter-threads et le throttling CFS qu'un pool de N workers (N = cœurs de l'hôte) provoquerait sous un quota de 1 CPU.
- **Postgres** : requêtes préparées en cache par connexion (`prepare_typed_cached`, types de paramètres explicites), pool de `DB_POOL_MAX` connexions, recyclage `Fast` (aucune requête de contrôle à l'emprunt), TCP_NODELAY côté driver et côté serveur HTTP.
- **JSON** : les lignes sont sérialisées directement depuis le buffer du driver (pas de `String` intermédiaire), buffer de sortie pré-dimensionné, réponses d'erreur en octets statiques ; parsing du corps avec emprunt (`Cow<str>`).
- **Build** : profil release `opt-level=3`, `lto="fat"`, `codegen-units=1`, `panic="abort"`, `strip=true`.
- **Image** : Dockerfile multi-étapes (couche de dépendances mise en cache via un `main` factice), image finale `distroless/cc-debian13:nonroot` (glibc, plus rapide que musl pour memcpy et les routines de chaînes).
- Arrêt propre sur SIGTERM (`with_graceful_shutdown`), aucun log par requête, aucun middleware.
