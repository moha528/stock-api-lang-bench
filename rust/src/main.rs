//! Point d'entrée : lit la config, crée le pool Postgres, démarre le serveur HTTP.

mod db;
mod routes;

use std::env;

use axum::serve::ListenerExt;
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use tokio::net::TcpListener;
use tokio_postgres::NoTls;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn env_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

// Le conteneur n'a qu'un vCPU : un runtime current_thread évite le vol de tâches,
// les synchronisations inter-threads et le throttling CFS d'un pool de N workers
// (N = cœurs de l'hôte) qui se disputeraient un quota de 1 CPU.
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let port: u16 = env_or("PORT", 8080);
    let database_url =
        env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://stock:stock@db:5432/stock".into());
    let pool_max: usize = env_or("DB_POOL_MAX", 20);

    let pg_config: tokio_postgres::Config = database_url.parse().expect("DATABASE_URL invalide");
    let mut manager_config = ManagerConfig::default();
    // Recyclage sans requête de vérification : aucun aller-retour supplémentaire par emprunt.
    manager_config.recycling_method = RecyclingMethod::Fast;
    let manager = Manager::from_config(pg_config, NoTls, manager_config);
    let pool = Pool::builder(manager)
        .max_size(pool_max)
        .build()
        .expect("création du pool impossible");

    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind impossible")
        .tap_io(|tcp| {
            let _ = tcp.set_nodelay(true);
        });

    eprintln!("stock-api (rust) en écoute sur 0.0.0.0:{port}");
    axum::serve(listener, routes::router(pool))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("erreur serveur");
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("handler SIGTERM");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
