# Traitements lourds — spécification commune (Rust et Java)

Cinq endpoints CPU, ajoutés aux apps `rust/` et `java/` existantes. Ils ne touchent pas la base. Chacun reproduit un type de traitement métier lourd. Tout est **déterministe** : à paramètres égaux, Rust, Java et la référence JS ([heavy-reference.mjs](heavy-reference.mjs)) doivent renvoyer exactement le même JSON (mêmes valeurs ; l'ordre des clés et l'écriture des nombres peuvent différer). [heavy-check.mjs](heavy-check.mjs) le vérifie.

## Exécution

- Le travail lourd ne tourne **jamais** sur la boucle d'événements I/O. Il part sur un **pool de workers de taille fixe = nombre de CPU disponibles** pour le conteneur (quota cgroup respecté : `std::thread::available_parallelism()` en Rust, `Runtime.availableProcessors()` en Java). File d'attente non bornée devant le pool.
- Les endpoints existants (SPEC.md) ne changent pas.
- Chaque langage utilise ses bibliothèques et optimisations les plus rapides (intrinsics, hasher rapide, parseur JSON rapide, etc.), tant que l'algorithme et le résultat restent ceux décrits ici.
- Paramètres invalides (absent quand obligatoire, non entier, hors bornes, JSON invalide) : 400 `{"error":"invalid_input"}`.

## Générateur pseudo-aléatoire commun : splitmix64

Entiers 64 bits **non signés**, arithmétique modulo 2^64 (Java : `long` avec `>>>`, `Long.remainderUnsigned`, `Long.toHexString`).

```
next():
  state = state + 0x9E3779B97F4A7C15
  z = state
  z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9
  z = (z ^ (z >>> 27)) * 0x94D049BB133111EB
  return z ^ (z >>> 31)

uniform():  (next() >>> 11) * 2^-53        // double dans [0, 1)
below(m):   next() mod m                    // modulo NON SIGNÉ
```

L'état initial est le `seed` de la requête. Paramètre `seed` : entier 0 ≤ seed ≤ 2^53−1, défaut 42.

## 1. `GET /cpu/hash?rounds=R&seed=S` — hachage itéré (signatures, dérivation de clés)

- `rounds` : 1..5 000 000, défaut 200 000.
- `h = SHA-256(seed sur 8 octets big-endian)`, puis `rounds − 1` fois : `h = SHA-256(h)` (32 octets).
- 200 : `{"digest":"<64 caractères hex minuscules>"}`

## 2. `GET /cpu/montecarlo?paths=P&steps=T&seed=S` — simulation Monte-Carlo (tarification, risque)

- `paths` : 1..1 000 000, défaut 20 000. `steps` : 1..10 000, défaut 252.
- Constantes : `s0 = 100.0`, `k = 100.0`, `mu = 0.05`, `sigma = 0.2`, `SQRT3 = 1.7320508075688772`.
- `dt = 1.0 / T`, `sqrtDt = sqrt(dt)`, `drift = mu * dt`, `vol = sigma * sqrtDt`.
- Un seul générateur, consommé dans l'ordre. Pour chaque chemin : `s = s0` ; pour chaque pas : `z = (2.0 * uniform() - 1.0) * SQRT3` puis `s = s * (1.0 + drift + vol * z)`. Payoff = `max(s - k, 0.0)`, ajouté à `sum` dans l'ordre des chemins.
- Calculs en double IEEE 754, exactement dans cet ordre, **sans FMA ni réassociation** (pas de `-ffast-math`, pas de `Math.fma`, pas de parallélisation qui change l'ordre de la somme).
- 200 : `{"price": sum / P, "paths": P, "steps": T}`

## 3. `GET /cpu/reconcile?n=N&seed=S` — rapprochement de paiements (chaînes, table de hachage, allocations)

- `n` : 1..1 000 000, défaut 100 000.
- **Paiements** : pour i de 0 à n−1 : `ref = "PAY-" + hex16(next())` (16 chiffres hex minuscules, zéros à gauche), puis `amount = 100 + below(1 000 000)`.
- **Relevé bancaire**, pour chaque paiement dans l'ordre : `x = below(100)` ;
  - si `x < 5` : absent du relevé ;
  - sinon si `x < 10` : ligne `(ref, amount + 1 + below(500))` ;
  - sinon : ligne `(ref, amount)`.
  Puis `floor(n / 50)` lignes inconnues : `ref = "PAY-" + hex16(next())`, `amount = 100 + below(1 000 000)`.
- **Mélange** Fisher–Yates du relevé : pour i de len−1 à 1 : `j = below(i + 1)`, échanger i et j.
- **Rapprochement** : table ref → montant des paiements (les refs sont des chaînes allouées). Pour chaque ligne du relevé : ref connue et même montant → `matched++`, `matched_cents += amount` ; ref connue, montant différent → `mismatched++` ; ref inconnue → `unknown++`. Enfin `missing = n − matched − mismatched`.
- 200 : `{"matched":…, "mismatched":…, "missing":…, "unknown":…, "matched_cents":…}`

## 4. `GET /cpu/sort?n=N&seed=S` — tri de chaînes (exports, dédoublonnage)

- `n` : 1..1 000 000, défaut 100 000.
- Génère n chaînes de 16 caractères ; chaque caractère est `ALPHABET[below(36)]` avec `ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"`.
- Trie par ordre croissant des octets (ASCII).
- Empreinte : FNV-1a 64 bits (offset `0xcbf29ce484222325`, prime `0x100000001b3`) sur la concaténation des chaînes triées, chacune suivie de `\n`.
- 200 : `{"first":"<plus petite>", "last":"<plus grande>", "fnv":"<16 hex minuscules>"}`

## 5. `POST /cpu/commissions` — calcul de commissions en lot (parsing JSON, regroupement, sérialisation)

- Corps : `{"lines":[{"agent":"AG-0042","product":"AUTO","premium_cents":125000}, …]}`
  - `lines` : 1..200 000 éléments ; `agent` : chaîne 1..32 ; `product` ∈ `AUTO`, `HABITATION`, `SANTE`, `PREVOYANCE` ; `premium_cents` : entier 0..100 000 000. Champs inconnus ignorés. Sinon 400. Corps jusqu'à 16 Mo.
- Taux de base en points de base : AUTO 800, HABITATION 1000, SANTE 600, PREVOYANCE 1200.
- Bonus : un agent dont la somme des `premium_cents` atteint au moins 5 000 000 gagne +100 points de base sur **toutes** ses lignes.
- Commission d'une ligne = `floor(premium_cents × (taux + bonus) / 10 000)` en entier 64 bits. Commission d'un agent = somme de ses lignes.
- 200 :
  ```json
  {"agents":[{"agent":"AG-0042","lines":12,"premium_cents":1500000,"commission_cents":120000}, …],
   "total_commission_cents": 9876543}
  ```
  `agents` trié par `commission_cents` décroissant, puis `agent` croissant (ordre des octets).
