// Point d'entrée : lit la config, crée le pool Postgres, lance le serveur HTTP
// et gère l'arrêt propre sur SIGTERM/SIGINT.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/valyala/fasthttp"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	port := env("PORT", "8080")
	dbURL := env("DATABASE_URL", "postgres://stock:stock@db:5432/stock")
	poolMax, err := strconv.Atoi(env("DB_POOL_MAX", "20"))
	if err != nil || poolMax < 1 {
		log.Fatalf("DB_POOL_MAX invalide: %q", os.Getenv("DB_POOL_MAX"))
	}

	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Fatalf("DATABASE_URL invalide: %v", err)
	}
	cfg.MaxConns = int32(poolMax)
	// Requêtes préparées automatiquement et mises en cache par connexion,
	// résultats au format binaire (c'est le mode par défaut de pgx, explicité ici).
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheStatement

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		log.Fatalf("pool postgres: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		log.Printf("postgres injoignable au démarrage (le pool réessaiera): %v", err)
	}

	srv := &fasthttp.Server{
		Handler:                       newRouter(&Store{pool: pool}).handle,
		Name:                          "",
		NoDefaultServerHeader:         true,
		NoDefaultContentType:          true,
		DisableHeaderNamesNormalizing: true,
		IdleTimeout:                   30 * time.Second,
		MaxRequestBodySize:            1 << 20,
	}

	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe("0.0.0.0:" + port) }()
	log.Printf("stock-api go en écoute sur :%s (pool max %d)", port, poolMax)

	select {
	case err := <-errc:
		if err != nil {
			log.Fatalf("serveur http: %v", err)
		}
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.ShutdownWithContext(shutdownCtx); err != nil {
		log.Printf("arrêt http: %v", err)
	}
	pool.Close()
	log.Print("arrêt propre terminé")
}
