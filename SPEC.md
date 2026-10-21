# Stock API — spécification commune

Les quatre implémentations (`node/`, `rust/`, `go/`, `java/`) exposent **exactement** la même API, exécutent **exactement** les mêmes requêtes SQL et renvoient **exactement** les mêmes JSON. Seuls changent le langage, le framework HTTP, le driver Postgres et les réglages de runtime : chacun utilise la pile la plus performante de son écosystème.

## Runtime

| Variable | Valeur par défaut | Rôle |
|---|---|---|
| `PORT` | `8080` | Port HTTP écouté sur `0.0.0.0` |
| `DATABASE_URL` | `postgres://stock:stock@db:5432/stock` | Connexion Postgres |
| `DB_POOL_MAX` | `20` | Taille max du pool (identique pour tous) |

Machine cible « légère » : chaque app tourne dans un conteneur limité à **1 vCPU et 512 Mo de RAM** (voir `docker-compose.yml`). Postgres est commun et identique pour tous.

## Modèle JSON

Produit (jamais de timestamps dans les réponses, pour que tout soit identique) :

```json
{"id":1,"sku":"SKU-000001","name":"Product 1","quantity":1000,"price_cents":137}
```

Tous les nombres sont des nombres JSON (jamais des chaînes), y compris les `bigint`. Toutes les réponses ont `Content-Type: application/json`.

Erreurs : `{"error":"<code>"}` avec `code` ∈ `invalid_input` (400), `not_found` (404), `conflict` (409), `insufficient_stock` (409).

## Endpoints

### `GET /health`
200 `{"status":"ok"}`. Ne touche pas la base.

### `GET /products?limit=50&offset=0`
- `limit` : entier, défaut 50, 1 ≤ limit ≤ 100. `offset` : entier, défaut 0, ≥ 0. Sinon 400.
- SQL : `SELECT id, sku, name, quantity, price_cents FROM products ORDER BY id LIMIT $1 OFFSET $2`
- 200 : tableau JSON de produits.

### `GET /products/{id}`
- `id` : entier > 0 (int64), sinon 400.
- SQL : `SELECT id, sku, name, quantity, price_cents FROM products WHERE id = $1`
- 200 produit, ou 404.

### `POST /products`
- Corps : `{"sku": string 1..64, "name": string 1..200, "quantity": int ≥ 0, "price_cents": int ≥ 0}`. Champ manquant, mauvais type, JSON invalide → 400. Les champs inconnus sont ignorés.
- SQL : `INSERT INTO products (sku, name, quantity, price_cents) VALUES ($1, $2, $3, $4) ON CONFLICT (sku) DO NOTHING RETURNING id, sku, name, quantity, price_cents`
- 201 produit créé, ou 409 `conflict` si aucune ligne retournée (SKU déjà pris).

### `POST /products/{id}/movements`
Entrée ou sortie de stock, atomique.
- `id` : entier > 0, sinon 400.
- Corps : `{"delta": int non nul, entre -1000000 et 1000000, "reason": string 1..100}`. Sinon 400.
- SQL (une seule instruction, donc atomique) :
  ```sql
  WITH upd AS (
    UPDATE products SET quantity = quantity + $2, updated_at = now()
    WHERE id = $1 AND quantity + $2 >= 0
    RETURNING id, quantity
  ), ins AS (
    INSERT INTO stock_movements (product_id, delta, reason)
    SELECT id, $2, $3 FROM upd
    RETURNING id
  )
  SELECT upd.quantity, ins.id FROM upd, ins
  ```
- Si une ligne : 200 `{"product_id":1,"quantity":995,"movement_id":42}`.
- Si aucune ligne : `SELECT 1 FROM products WHERE id = $1` → 404 `not_found` si absent, sinon 409 `insufficient_stock`.

### `GET /stats`
- SQL : `SELECT count(*)::bigint, coalesce(sum(quantity), 0)::bigint, coalesce(sum(quantity::bigint * price_cents), 0)::bigint FROM products`
- 200 `{"products":10000,"total_quantity":10000000,"total_value_cents":50995002750}`

Toute autre route : 404 `not_found`. Méthode non prévue sur une route connue : 404 ou 405, au choix.

## Règles d'implémentation communes

- Structure identique : un fichier/module pour le routage HTTP, un pour l'accès aux données (les requêtes ci-dessus, en requêtes préparées), un point d'entrée qui lit la config et crée le pool.
- Pas de cache applicatif, pas de logs par requête, pas de middleware superflu (compression, CORS…).
- Image Docker multi-étapes, build en mode release/optimisé, image finale la plus petite raisonnable.
- Arrêt propre sur SIGTERM.
