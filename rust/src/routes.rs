//! Routage HTTP, validation des entrées et construction des réponses JSON.

use std::borrow::Cow;

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{
        Path, Query, State,
        rejection::{BytesRejection, PathRejection, QueryRejection},
    },
    http::{HeaderValue, StatusCode, header},
    response::Response,
    routing::{get, post},
};
use deadpool_postgres::Pool;
use serde::{Deserialize, Serialize};

use crate::db::{self, Movement, ProductJson, ProductList};

pub fn router(pool: Pool) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/products", get(list_products).post(create_product))
        .route("/products/{id}", get(get_product))
        .route("/products/{id}/movements", post(create_movement))
        .route("/stats", get(stats))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .with_state(pool)
}

// ---------- réponses ----------

const APPLICATION_JSON: HeaderValue = HeaderValue::from_static("application/json");

fn raw_json(status: StatusCode, body: Body) -> Response {
    let mut res = Response::new(body);
    *res.status_mut() = status;
    res.headers_mut().insert(header::CONTENT_TYPE, APPLICATION_JSON);
    res
}

fn static_json(status: StatusCode, body: &'static [u8]) -> Response {
    raw_json(status, Body::from(body))
}

fn json<T: Serialize>(status: StatusCode, value: &T, capacity: usize) -> Response {
    let mut buf = Vec::with_capacity(capacity);
    match serde_json::to_writer(&mut buf, value) {
        Ok(()) => raw_json(status, Body::from(buf)),
        Err(_) => internal_error(),
    }
}

fn invalid_input() -> Response {
    static_json(StatusCode::BAD_REQUEST, br#"{"error":"invalid_input"}"#)
}

fn not_found_response() -> Response {
    static_json(StatusCode::NOT_FOUND, br#"{"error":"not_found"}"#)
}

fn conflict() -> Response {
    static_json(StatusCode::CONFLICT, br#"{"error":"conflict"}"#)
}

fn insufficient_stock() -> Response {
    static_json(StatusCode::CONFLICT, br#"{"error":"insufficient_stock"}"#)
}

fn internal_error() -> Response {
    static_json(StatusCode::INTERNAL_SERVER_ERROR, br#"{"error":"internal_error"}"#)
}

impl From<db::DbError> for Response {
    fn from(_: db::DbError) -> Self {
        internal_error()
    }
}

// ---------- validation ----------

fn parse_id(raw: Result<Path<String>, PathRejection>) -> Option<i64> {
    let Path(raw) = raw.ok()?;
    raw.parse::<i64>().ok().filter(|&id| id > 0)
}

fn len_between(s: &str, min: usize, max: usize) -> bool {
    // Longueur en caractères (et non en octets), bornée sans parcourir toute la chaîne.
    if s.len() < min {
        return false;
    }
    let n = s.chars().take(max + 1).count();
    n >= min && n <= max
}

// ---------- handlers ----------

async fn health() -> Response {
    static_json(StatusCode::OK, br#"{"status":"ok"}"#)
}

async fn not_found() -> Response {
    not_found_response()
}

#[derive(Deserialize)]
struct ListParams {
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn list_products(
    State(pool): State<Pool>,
    params: Result<Query<ListParams>, QueryRejection>,
) -> Response {
    let Ok(Query(params)) = params else { return invalid_input() };
    let limit = params.limit.unwrap_or(50);
    let offset = params.offset.unwrap_or(0);
    if !(1..=100).contains(&limit) || offset < 0 {
        return invalid_input();
    }
    match db::list_products(&pool, limit, offset).await {
        Ok(rows) => json(StatusCode::OK, &ProductList(&rows), 16 + rows.len() * 96),
        Err(e) => e.into(),
    }
}

async fn get_product(
    State(pool): State<Pool>,
    id: Result<Path<String>, PathRejection>,
) -> Response {
    let Some(id) = parse_id(id) else { return invalid_input() };
    match db::get_product(&pool, id).await {
        Ok(Some(row)) => json(StatusCode::OK, &ProductJson(&row), 128),
        Ok(None) => not_found_response(),
        Err(e) => e.into(),
    }
}

#[derive(Deserialize)]
struct NewProduct<'a> {
    #[serde(borrow)]
    sku: Cow<'a, str>,
    #[serde(borrow)]
    name: Cow<'a, str>,
    // Colonne INTEGER : une valeur hors int32 est une entrée invalide.
    quantity: i32,
    price_cents: i64,
}

async fn create_product(
    State(pool): State<Pool>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let Ok(body) = body else { return invalid_input() };
    let Ok(p) = serde_json::from_slice::<NewProduct>(&body) else { return invalid_input() };
    if !len_between(&p.sku, 1, 64)
        || !len_between(&p.name, 1, 200)
        || p.quantity < 0
        || p.price_cents < 0
    {
        return invalid_input();
    }
    match db::create_product(&pool, &p.sku, &p.name, p.quantity, p.price_cents).await {
        Ok(Some(row)) => json(StatusCode::CREATED, &ProductJson(&row), 128),
        Ok(None) => conflict(),
        Err(e) => e.into(),
    }
}

#[derive(Deserialize)]
struct NewMovement<'a> {
    delta: i32,
    #[serde(borrow)]
    reason: Cow<'a, str>,
}

#[derive(Serialize)]
struct MovementResult {
    product_id: i64,
    quantity: i32,
    movement_id: i64,
}

async fn create_movement(
    State(pool): State<Pool>,
    id: Result<Path<String>, PathRejection>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let Some(id) = parse_id(id) else { return invalid_input() };
    let Ok(body) = body else { return invalid_input() };
    let Ok(m) = serde_json::from_slice::<NewMovement>(&body) else { return invalid_input() };
    if m.delta == 0 || !(-1_000_000..=1_000_000).contains(&m.delta) || !len_between(&m.reason, 1, 100)
    {
        return invalid_input();
    }
    match db::apply_movement(&pool, id, m.delta, &m.reason).await {
        Ok(Movement::Applied { quantity, movement_id }) => json(
            StatusCode::OK,
            &MovementResult { product_id: id, quantity, movement_id },
            64,
        ),
        Ok(Movement::NotFound) => not_found_response(),
        Ok(Movement::InsufficientStock) => insufficient_stock(),
        Err(e) => e.into(),
    }
}

async fn stats(State(pool): State<Pool>) -> Response {
    match db::stats(&pool).await {
        Ok(s) => json(StatusCode::OK, &s, 96),
        Err(e) => e.into(),
    }
}
