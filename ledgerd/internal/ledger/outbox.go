package ledger

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Publisher interface {
	Publish(ctx context.Context, topic string, payload []byte) error
}

// LogPublisher is a stand-in. Swap for an HTTP-webhook, NATS, Kafka or SQS publisher.
type LogPublisher struct{ Log *slog.Logger }

func (p LogPublisher) Publish(_ context.Context, topic string, payload []byte) error {
	p.Log.Info("outbox publish", "topic", topic, "payload", string(payload))
	return nil
}

// Relay polls the outbox and publishes AT LEAST ONCE. Consumers must be idempotent (dedupe on transaction_id).
// FOR UPDATE SKIP LOCKED lets you run several relay replicas without double-claiming rows.
type Relay struct {
	Pool     *pgxpool.Pool
	Pub      Publisher
	Log      *slog.Logger
	Interval time.Duration
}

func (r *Relay) Run(ctx context.Context) {
	t := time.NewTicker(r.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := r.drain(ctx); err != nil && ctx.Err() == nil {
				r.Log.Error("outbox drain failed", "err", err)
			}
		}
	}
}

func (r *Relay) drain(ctx context.Context) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	type msg struct {
		id      int64
		topic   string
		payload []byte
	}
	rows, err := tx.Query(ctx, `
		SELECT id, topic, payload::text FROM outbox
		WHERE published_at IS NULL ORDER BY id LIMIT 100
		FOR UPDATE SKIP LOCKED`)
	if err != nil {
		return err
	}
	var batch []msg
	for rows.Next() {
		var m msg
		var p string
		if err := rows.Scan(&m.id, &m.topic, &p); err != nil {
			rows.Close()
			return err
		}
		m.payload = []byte(p)
		batch = append(batch, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, m := range batch {
		if err := r.Pub.Publish(ctx, m.topic, m.payload); err != nil {
			r.Log.Warn("publish failed; will retry", "id", m.id, "err", err)
			break // preserve ordering: stop at first failure, commit what succeeded
		}
		if _, err := tx.Exec(ctx, `UPDATE outbox SET published_at = now() WHERE id = $1`, m.id); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
