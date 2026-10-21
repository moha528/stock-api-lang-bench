//! Traitements lourds en CPU (SPEC-heavy.md) : 5 endpoints `/cpu/*`.
//!
//! Le calcul ne tourne jamais sur le runtime tokio : chaque requête part sur un pool rayon
//! dédié, de taille fixe `available_parallelism()` (quota cgroup respecté), file non bornée,
//! et la réponse revient par un `tokio::sync::oneshot`. Le parsing du corps et la
//! sérialisation de la réponse se font aussi sur le worker.

use std::{borrow::Cow, cmp::Ordering, collections::HashMap, fmt, sync::OnceLock};

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Query, rejection::BytesRejection, rejection::QueryRejection},
    http::StatusCode,
    response::Response,
    routing::{get, post},
};
use foldhash::fast::RandomState;
use serde::{
    Deserialize, Deserializer,
    de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor},
};
use tokio::sync::oneshot;

use crate::routes::{internal_error, invalid_input, raw_json};

// ---------- pool de workers ----------

static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();

/// Crée le pool CPU (à appeler une fois au démarrage) et logue sa taille.
pub fn init_pool() {
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(n)
        .thread_name(|i| format!("cpu-worker-{i}"))
        .build()
        .expect("création du pool CPU impossible");
    eprintln!("pool CPU : {n} workers (available_parallelism)");
    let _ = POOL.set(pool);
}

/// Exécute `job` sur le pool CPU et attend son résultat sans bloquer le runtime I/O.
/// `Ok(corps JSON)` -> 200, `Err(())` -> 400 invalid_input.
async fn offload<F>(job: F) -> Response
where
    F: FnOnce() -> Result<Vec<u8>, ()> + Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    POOL.get().expect("pool CPU non initialisé").spawn(move || {
        let _ = tx.send(job());
    });
    match rx.await {
        Ok(Ok(body)) => raw_json(StatusCode::OK, Body::from(body)),
        Ok(Err(())) => invalid_input(),
        Err(_) => internal_error(),
    }
}

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/cpu/hash", get(hash))
        .route("/cpu/montecarlo", get(montecarlo))
        .route("/cpu/reconcile", get(reconcile))
        .route("/cpu/sort", get(sort))
        .route(
            "/cpu/commissions",
            post(commissions).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
}

// ---------- générateur commun : splitmix64 ----------

struct SplitMix64(u64);

impl SplitMix64 {
    #[inline(always)]
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Double dans [0, 1) : conversion exacte d'un entier 53 bits, puis × 2^-53 (exact).
    #[inline(always)]
    fn uniform(&mut self) -> f64 {
        (self.next() >> 11) as f64 * (1.0 / 9_007_199_254_740_992.0)
    }

    #[inline(always)]
    fn below(&mut self, m: u64) -> u64 {
        self.next() % m
    }
}

// ---------- paramètres ----------

const SEED_MAX: i64 = (1 << 53) - 1;

fn bounded(v: Option<i64>, default: i64, min: i64, max: i64) -> Result<i64, ()> {
    let v = v.unwrap_or(default);
    if (min..=max).contains(&v) { Ok(v) } else { Err(()) }
}

fn seed(v: Option<i64>) -> Result<u64, ()> {
    bounded(v, 42, 0, SEED_MAX).map(|s| s as u64)
}

// ---------- écriture JSON ----------

const HEX: &[u8; 16] = b"0123456789abcdef";

#[inline]
fn push_int<I: itoa::Integer>(buf: &mut Vec<u8>, v: I) {
    buf.extend_from_slice(itoa::Buffer::new().format(v).as_bytes());
}

#[inline]
fn push_hex16(buf: &mut Vec<u8>, v: u64) {
    for k in (0..16).rev() {
        buf.push(HEX[((v >> (k * 4)) & 0xF) as usize]);
    }
}

// ---------- 1. hachage itéré ----------

#[derive(Deserialize)]
struct HashParams {
    rounds: Option<i64>,
    seed: Option<i64>,
}

async fn hash(params: Result<Query<HashParams>, QueryRejection>) -> Response {
    let Ok(Query(p)) = params else { return invalid_input() };
    let (Ok(rounds), Ok(seed)) = (bounded(p.rounds, 200_000, 1, 5_000_000), seed(p.seed)) else {
        return invalid_input();
    };
    offload(move || Ok(hash_job(rounds as u32, seed))).await
}

const SHA256_IV: [u32; 8] = [
    0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab,
    0x5be0_cd19,
];

/// SHA-256 itéré. Chaque message (8 puis 32 octets) tient dans un seul bloc de 64 octets :
/// le padding (0x80, zéros, longueur en bits big-endian) est posé une fois pour toutes et
/// seule la fonction de compression (SHA-NI si disponible) tourne à chaque tour.
/// C'est exactement SHA-256, sans la gestion de tampon générique de l'API `Digest`.
fn hash_job(rounds: u32, seed: u64) -> Vec<u8> {
    let mut block = [0u8; 64];
    block[..8].copy_from_slice(&seed.to_be_bytes());
    block[8] = 0x80;
    block[56..].copy_from_slice(&64u64.to_be_bytes());
    let mut state = SHA256_IV;
    sha2::block_api::compress256(&mut state, std::slice::from_ref(&block));

    // Blocs suivants : h (32 octets) || 0x80 || zéros || 256 bits.
    let mut block = [0u8; 64];
    block[32] = 0x80;
    block[56..].copy_from_slice(&256u64.to_be_bytes());
    for _ in 1..rounds {
        for (i, w) in state.iter().enumerate() {
            block[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes());
        }
        state = SHA256_IV;
        sha2::block_api::compress256(&mut state, std::slice::from_ref(&block));
    }

    let mut buf = Vec::with_capacity(80);
    buf.extend_from_slice(br#"{"digest":""#);
    for w in state {
        for b in w.to_be_bytes() {
            buf.push(HEX[(b >> 4) as usize]);
            buf.push(HEX[(b & 0xF) as usize]);
        }
    }
    buf.extend_from_slice(br#""}"#);
    buf
}

// ---------- 2. Monte-Carlo ----------

#[derive(Deserialize)]
struct MonteCarloParams {
    paths: Option<i64>,
    steps: Option<i64>,
    seed: Option<i64>,
}

async fn montecarlo(params: Result<Query<MonteCarloParams>, QueryRejection>) -> Response {
    let Ok(Query(p)) = params else { return invalid_input() };
    let (Ok(paths), Ok(steps), Ok(seed)) = (
        bounded(p.paths, 20_000, 1, 1_000_000),
        bounded(p.steps, 252, 1, 10_000),
        seed(p.seed),
    ) else {
        return invalid_input();
    };
    offload(move || Ok(montecarlo_job(paths as u32, steps as u32, seed))).await
}

/// Arithmétique IEEE 754 stricte : Rust ne contracte jamais `a * b + c` en FMA et ne
/// réassocie pas les flottants ; l'ordre des opérations et de la somme est celui de la spec.
fn montecarlo_job(paths: u32, steps: u32, seed: u64) -> Vec<u8> {
    const S0: f64 = 100.0;
    const K: f64 = 100.0;
    const MU: f64 = 0.05;
    const SIGMA: f64 = 0.2;
    const SQRT3: f64 = 1.732_050_807_568_877_2;

    let mut r = SplitMix64(seed);
    let dt = 1.0 / steps as f64;
    let sqrt_dt = dt.sqrt();
    let drift = MU * dt;
    let vol = SIGMA * sqrt_dt;
    // `1.0 + drift + vol * z` s'évalue (1.0 + drift) + (vol * z) : le premier terme est constant.
    let one_plus_drift = 1.0 + drift;

    let mut sum = 0.0f64;
    for _ in 0..paths {
        let mut s = S0;
        for _ in 0..steps {
            let z = (2.0 * r.uniform() - 1.0) * SQRT3;
            s *= one_plus_drift + vol * z;
        }
        sum += (s - K).max(0.0);
    }
    let price = sum / paths as f64;

    let mut buf = Vec::with_capacity(64);
    buf.extend_from_slice(br#"{"price":"#);
    buf.extend_from_slice(ryu::Buffer::new().format_finite(price).as_bytes());
    buf.extend_from_slice(br#","paths":"#);
    push_int(&mut buf, paths);
    buf.extend_from_slice(br#","steps":"#);
    push_int(&mut buf, steps);
    buf.push(b'}');
    buf
}

// ---------- 3. rapprochement ----------

#[derive(Deserialize)]
struct SizeParams {
    n: Option<i64>,
    seed: Option<i64>,
}

fn size_params(params: Result<Query<SizeParams>, QueryRejection>) -> Result<(usize, u64), ()> {
    let Query(p) = params.map_err(|_| ())?;
    Ok((bounded(p.n, 100_000, 1, 1_000_000)? as usize, seed(p.seed)?))
}

async fn reconcile(params: Result<Query<SizeParams>, QueryRejection>) -> Response {
    let Ok((n, seed)) = size_params(params) else { return invalid_input() };
    offload(move || Ok(reconcile_job(n, seed))).await
}

/// `"PAY-" + hex16(v)` : une `String` de 20 octets allouée sur le tas, capacité exacte.
#[inline]
fn payment_ref(v: u64) -> String {
    let mut b = [0u8; 20];
    b[..4].copy_from_slice(b"PAY-");
    for (k, c) in b[4..].iter_mut().enumerate() {
        *c = HEX[((v >> (60 - 4 * k)) & 0xF) as usize];
    }
    // SAFETY : uniquement de l'ASCII.
    unsafe { String::from_utf8_unchecked(b.to_vec()) }
}

fn reconcile_job(n: usize, seed: u64) -> Vec<u8> {
    let mut r = SplitMix64(seed);
    let unknown_count = n / 50;

    // Toutes les références (paiements puis lignes inconnues) sont des `String` du tas ;
    // le relevé les désigne par indice, comme une liste Java partage ses références.
    let mut refs: Vec<String> = Vec::with_capacity(n + unknown_count);
    let mut amounts: Vec<u64> = Vec::with_capacity(n);
    for _ in 0..n {
        refs.push(payment_ref(r.next()));
        amounts.push(100 + r.below(1_000_000));
    }

    let mut bank: Vec<(u32, u64)> = Vec::with_capacity(n + unknown_count);
    for (i, &amount) in amounts.iter().enumerate() {
        let x = r.below(100);
        if x < 5 {
            continue;
        }
        if x < 10 {
            bank.push((i as u32, amount + 1 + r.below(500)));
        } else {
            bank.push((i as u32, amount));
        }
    }
    for _ in 0..unknown_count {
        let rf = payment_ref(r.next());
        let amount = 100 + r.below(1_000_000);
        bank.push((refs.len() as u32, amount));
        refs.push(rf);
    }

    // Fisher–Yates.
    for i in (1..bank.len()).rev() {
        let j = r.below(i as u64 + 1) as usize;
        bank.swap(i, j);
    }

    // Table ref -> montant, clés = chaînes des paiements, hasher foldhash, pré-dimensionnée.
    let mut table: HashMap<&str, u64, RandomState> =
        HashMap::with_capacity_and_hasher(n, RandomState::default());
    for (rf, &amount) in refs[..n].iter().zip(&amounts) {
        table.insert(rf.as_str(), amount);
    }

    let (mut matched, mut mismatched, mut unknown, mut matched_cents) = (0u64, 0u64, 0u64, 0u64);
    for &(idx, amount) in &bank {
        match table.get(refs[idx as usize].as_str()) {
            None => unknown += 1,
            Some(&a) if a == amount => {
                matched += 1;
                matched_cents += amount;
            }
            Some(_) => mismatched += 1,
        }
    }
    let missing = n as u64 - matched - mismatched;

    let mut buf = Vec::with_capacity(128);
    buf.extend_from_slice(br#"{"matched":"#);
    push_int(&mut buf, matched);
    buf.extend_from_slice(br#","mismatched":"#);
    push_int(&mut buf, mismatched);
    buf.extend_from_slice(br#","missing":"#);
    push_int(&mut buf, missing);
    buf.extend_from_slice(br#","unknown":"#);
    push_int(&mut buf, unknown);
    buf.extend_from_slice(br#","matched_cents":"#);
    push_int(&mut buf, matched_cents);
    buf.push(b'}');
    buf
}

// ---------- 4. tri de chaînes ----------

async fn sort(params: Result<Query<SizeParams>, QueryRejection>) -> Response {
    let Ok((n, seed)) = size_params(params) else { return invalid_input() };
    offload(move || Ok(sort_job(n, seed))).await
}

/// Ordre des octets, identique à `<[u8]>::cmp`, mais les 8 premiers octets sont comparés
/// d'un coup en entier big-endian (ils départagent presque toujours) au lieu d'un appel memcmp.
#[inline(always)]
fn bytes_cmp(a: &[u8], b: &[u8]) -> Ordering {
    if let (Some(pa), Some(pb)) = (a.first_chunk::<8>(), b.first_chunk::<8>()) {
        match u64::from_be_bytes(*pa).cmp(&u64::from_be_bytes(*pb)) {
            Ordering::Equal => a[8..].cmp(&b[8..]),
            o => o,
        }
    } else {
        a.cmp(b)
    }
}

fn sort_job(n: usize, seed: u64) -> Vec<u8> {
    const ALPHABET: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut r = SplitMix64(seed);
    let mut xs: Vec<String> = Vec::with_capacity(n);
    for _ in 0..n {
        let mut b = [0u8; 16];
        for c in &mut b {
            *c = ALPHABET[r.below(36) as usize];
        }
        // SAFETY : uniquement de l'ASCII. Une `String` de 16 octets allouée par élément.
        xs.push(unsafe { String::from_utf8_unchecked(b.to_vec()) });
    }

    // Tri non stable : deux chaînes égales sont indiscernables, le résultat est le même.
    xs.sort_unstable_by(|a, b| bytes_cmp(a.as_bytes(), b.as_bytes()));

    let mut h = FNV_OFFSET;
    for s in &xs {
        for &c in s.as_bytes() {
            h = (h ^ c as u64).wrapping_mul(FNV_PRIME);
        }
        h = (h ^ b'\n' as u64).wrapping_mul(FNV_PRIME);
    }

    let mut buf = Vec::with_capacity(96);
    buf.extend_from_slice(br#"{"first":""#);
    buf.extend_from_slice(xs[0].as_bytes());
    buf.extend_from_slice(br#"","last":""#);
    buf.extend_from_slice(xs[n - 1].as_bytes());
    buf.extend_from_slice(br#"","fnv":""#);
    push_hex16(&mut buf, h);
    buf.extend_from_slice(br#""}"#);
    buf
}

// ---------- 5. commissions ----------

async fn commissions(body: Result<Bytes, BytesRejection>) -> Response {
    let Ok(body) = body else { return invalid_input() };
    offload(move || commissions_job(&body)).await
}

const MAX_LINES: usize = 200_000;
const MAX_PREMIUM: u64 = 100_000_000;
const BONUS_THRESHOLD: u64 = 5_000_000;
const BONUS_BP: u64 = 100;

struct AgentAcc<'a> {
    name: Cow<'a, str>,
    lines: u32,
    premium_cents: u64,
    commission_cents: u64,
}

/// Lot parsé et regroupé au fil du parsing : chaque ligne est validée dès sa lecture,
/// l'agent est indexé dans une table (clés empruntées au corps, sans copie), et on garde
/// (agent, taux, prime) par ligne pour la seconde passe (le bonus dépend du total de l'agent).
struct Batch<'a> {
    index: HashMap<Cow<'a, str>, u32, RandomState>,
    agents: Vec<AgentAcc<'a>>,
    lines: Vec<(u32, u32, u32)>,
}

#[derive(Deserialize)]
struct Line<'a> {
    #[serde(borrow)]
    agent: Cow<'a, str>,
    #[serde(borrow)]
    product: Cow<'a, str>,
    premium_cents: u64,
}

fn base_rate(product: &str) -> Option<u32> {
    match product {
        "AUTO" => Some(800),
        "HABITATION" => Some(1000),
        "SANTE" => Some(600),
        "PREVOYANCE" => Some(1200),
        _ => None,
    }
}

impl<'a> Batch<'a> {
    fn push<E: de::Error>(&mut self, line: Line<'a>) -> Result<(), E> {
        if self.lines.len() >= MAX_LINES {
            return Err(E::custom("too many lines"));
        }
        let rate = base_rate(&line.product).ok_or_else(|| E::custom("product"))?;
        let agent_len = line.agent.chars().take(33).count();
        if !(1..=32).contains(&agent_len) || line.premium_cents > MAX_PREMIUM {
            return Err(E::custom("line"));
        }
        let idx = match self.index.get(line.agent.as_ref()) {
            Some(&i) => i,
            None => {
                let i = self.agents.len() as u32;
                self.agents.push(AgentAcc {
                    name: line.agent.clone(),
                    lines: 0,
                    premium_cents: 0,
                    commission_cents: 0,
                });
                self.index.insert(line.agent, i);
                i
            }
        };
        let acc = &mut self.agents[idx as usize];
        acc.lines += 1;
        acc.premium_cents += line.premium_cents;
        self.lines.push((idx, rate, line.premium_cents as u32));
        Ok(())
    }
}

struct LinesSeed<'b, 'a>(&'b mut Batch<'a>);

impl<'de> DeserializeSeed<'de> for LinesSeed<'_, 'de> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for LinesSeed<'_, 'de> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a lines array")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(line) = seq.next_element::<Line<'de>>()? {
            self.0.push(line)?;
        }
        Ok(())
    }
}

/// Clé de l'objet racine : seul `lines` compte, les autres sont ignorées sans allocation.
enum RootKey {
    Lines,
    Other,
}

impl<'de> Deserialize<'de> for RootKey {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = RootKey;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a field name")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<RootKey, E> {
                Ok(if v == "lines" { RootKey::Lines } else { RootKey::Other })
            }
        }
        d.deserialize_identifier(V)
    }
}

struct BatchVisitor;

impl<'de> Visitor<'de> for BatchVisitor {
    type Value = Batch<'de>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a commissions batch")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Batch<'de>, M::Error> {
        let mut batch: Option<Batch<'de>> = None;
        while let Some(key) = map.next_key::<RootKey>()? {
            if let RootKey::Lines = key {
                let mut b = Batch {
                    index: HashMap::with_capacity_and_hasher(1024, RandomState::default()),
                    agents: Vec::with_capacity(1024),
                    lines: Vec::with_capacity(4096),
                };
                map.next_value_seed(LinesSeed(&mut b))?;
                batch = Some(b);
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        batch.ok_or_else(|| de::Error::missing_field("lines"))
    }
}

fn commissions_job(body: &[u8]) -> Result<Vec<u8>, ()> {
    let mut de = serde_json::Deserializer::from_slice(body);
    let mut batch = (&mut de).deserialize_map(BatchVisitor).map_err(|_| ())?;
    de.end().map_err(|_| ())?;
    if batch.lines.is_empty() {
        return Err(());
    }

    // Seconde passe : commission ligne à ligne, avec le bonus de l'agent.
    let agents = &mut batch.agents;
    for &(idx, rate, premium) in &batch.lines {
        let acc = &mut agents[idx as usize];
        let bonus = if acc.premium_cents >= BONUS_THRESHOLD { BONUS_BP } else { 0 };
        acc.commission_cents += premium as u64 * (rate as u64 + bonus) / 10_000;
    }
    let total: u64 = agents.iter().map(|a| a.commission_cents).sum();

    // Commission décroissante puis agent croissant (octets) ; les agents sont uniques.
    agents.sort_unstable_by(|x, y| {
        y.commission_cents
            .cmp(&x.commission_cents)
            .then_with(|| x.name.as_bytes().cmp(y.name.as_bytes()))
    });

    let mut buf = Vec::with_capacity(48 + agents.len() * 112);
    buf.extend_from_slice(br#"{"agents":["#);
    for (i, a) in agents.iter().enumerate() {
        if i > 0 {
            buf.push(b',');
        }
        buf.extend_from_slice(br#"{"agent":"#);
        serde_json::to_writer(&mut buf, a.name.as_ref()).map_err(|_| ())?;
        buf.extend_from_slice(br#","lines":"#);
        push_int(&mut buf, a.lines);
        buf.extend_from_slice(br#","premium_cents":"#);
        push_int(&mut buf, a.premium_cents);
        buf.extend_from_slice(br#","commission_cents":"#);
        push_int(&mut buf, a.commission_cents);
        buf.push(b'}');
    }
    buf.extend_from_slice(br#"],"total_commission_cents":"#);
    push_int(&mut buf, total);
    buf.push(b'}');
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn hash_matches_digest_api() {
        for (rounds, seed) in [(1u32, 0u64), (2, 7), (1000, 7), (5, SEED_MAX as u64)] {
            let mut h = Sha256::digest(seed.to_be_bytes());
            for _ in 1..rounds {
                h = Sha256::digest(h);
            }
            let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
            let got = String::from_utf8(hash_job(rounds, seed)).unwrap();
            assert_eq!(got, format!(r#"{{"digest":"{hex}"}}"#));
        }
    }

    #[test]
    fn bytes_cmp_matches_slice_cmp() {
        let xs: [&[u8]; 6] = [b"", b"abc", b"abcdefgh", b"abcdefghi", b"abcdefgz", b"b"];
        for a in xs {
            for b in xs {
                assert_eq!(bytes_cmp(a, b), a.cmp(b));
            }
        }
    }
}
