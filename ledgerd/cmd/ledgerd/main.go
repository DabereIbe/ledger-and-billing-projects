package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/DabereIbe/ledgerd/internal/httpapi"
	"github.com/DabereIbe/ledgerd/internal/ledger"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	dsn := mustEnv(log, "DATABASE_URL")
	apiKey := mustEnv(log, "LEDGER_API_KEY")
	addr := getenv("ADDR", ":8080")

	// Cancelled on SIGINT/SIGTERM: one context drives graceful shutdown of everything.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Error("db connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	svc := ledger.NewService(pool)

	// Background workers share the root context, so they stop when the server does.
	relay := &ledger.Relay{Pool: pool, Pub: ledger.LogPublisher{Log: log}, Log: log, Interval: time.Second}
	go relay.Run(ctx)
	go reconcileLoop(ctx, svc, log, time.Minute)

	api := &httpapi.API{Svc: svc, APIKey: apiKey, Log: log}
	srv := &http.Server{
		Addr:              addr,
		Handler:           api.Routes(),
		ReadHeaderTimeout: 5 * time.Second, // mitigates slowloris
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		log.Info("listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx) // stop accepting, let in-flight requests finish
}

func reconcileLoop(ctx context.Context, svc *ledger.Service, log *slog.Logger, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			bad, err := svc.Reconcile(ctx)
			if err != nil || len(bad) > 0 {
				log.Error("RECONCILIATION FAILED", "discrepancies", bad, "err", err) // page someone in real life
			}
		}
	}
}

func mustEnv(log *slog.Logger, k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Error("missing env var", "key", k)
		os.Exit(1)
	}
	return v
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
