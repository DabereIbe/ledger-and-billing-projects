package ledger

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxAmount caps a single entry so SUM() and balance arithmetic can never overflow int64.
const MaxAmount int64 = 1_000_000_000_000_000

var (
	ErrInvalid             = errors.New("invalid request")
	ErrUnbalanced          = errors.New("entries do not sum to zero")
	ErrInsufficientFunds   = errors.New("insufficient funds")
	ErrAccountNotFound     = errors.New("account not found")
	ErrCurrencyMismatch    = errors.New("all accounts in a transaction must share a currency")
	ErrIdempotencyConflict = errors.New("idempotency key reused with a different request")
)

type Entry struct {
	AccountID string `json:"account_id"`
	Amount    int64  `json:"amount"` // debit > 0, credit < 0, minor units
}

type PostInput struct {
	IdempotencyKey string
	Description    string
	Entries        []Entry
}

type PostResult struct {
	TransactionID string
	Replayed      bool
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// Post records one balanced, idempotent transaction atomically.
//
// Concurrency strategy (the part interviewers care about):
//  1. Claim the idempotency key with INSERT ... ON CONFLICT DO NOTHING. The unique index makes a concurrent
//     duplicate BLOCK until the first transaction commits or rolls back, so exactly one request does the work.
//  2. Lock every touched account row with SELECT ... FOR UPDATE in a deterministic order (ORDER BY id).
//     Consistent lock ordering means two transfers A->B and B->A cannot deadlock.
//  3. Check funds against the locked, current balance, so there is no read-then-write race.
func (s *Service) Post(ctx context.Context, in PostInput) (PostResult, error) {
	if err := validate(in); err != nil {
		return PostResult{}, err
	}
	hash := requestHash(in)

	tx, err := s.pool.Begin(ctx) // READ COMMITTED + row locks; see study notes for why not SERIALIZABLE
	if err != nil {
		return PostResult{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after Commit

	var txnID string
	err = tx.QueryRow(ctx, `
		INSERT INTO transactions (idempotency_key, request_hash, description)
		VALUES ($1, $2, $3)
		ON CONFLICT (idempotency_key) DO NOTHING
		RETURNING id::text`, in.IdempotencyKey, hash, in.Description).Scan(&txnID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return replay(ctx, tx, in.IdempotencyKey, hash)
	case err != nil:
		return PostResult{}, err
	}

	ids := make([]string, len(in.Entries))
	for i, e := range in.Entries {
		ids[i] = e.AccountID
	}

	type acct struct {
		currency string
		allowNeg bool
		balance  int64
	}
	accts := make(map[string]*acct, len(ids))

	rows, err := tx.Query(ctx, `
		SELECT id::text, currency, allow_negative, balance
		FROM accounts
		WHERE id = ANY($1::uuid[])
		ORDER BY id
		FOR UPDATE`, ids)
	if err != nil {
		return PostResult{}, err
	}
	for rows.Next() {
		var id string
		var a acct
		if err := rows.Scan(&id, &a.currency, &a.allowNeg, &a.balance); err != nil {
			rows.Close()
			return PostResult{}, err
		}
		accts[id] = &a
	}
	rows.Close() // must close before reusing the tx connection
	if err := rows.Err(); err != nil {
		return PostResult{}, err
	}
	if len(accts) != len(ids) {
		return PostResult{}, ErrAccountNotFound
	}

	var currency string
	for _, a := range accts {
		if currency == "" {
			currency = a.currency
		} else if a.currency != currency {
			return PostResult{}, ErrCurrencyMismatch
		}
	}

	for _, e := range in.Entries {
		a := accts[e.AccountID]
		newBal := a.balance + e.Amount
		if newBal < 0 && !a.allowNeg {
			return PostResult{}, fmt.Errorf("%w: account %s", ErrInsufficientFunds, e.AccountID)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO entries (transaction_id, account_id, amount, balance_after)
			VALUES ($1, $2, $3, $4)`, txnID, e.AccountID, e.Amount, newBal); err != nil {
			return PostResult{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE accounts SET balance = $1 WHERE id = $2`, newBal, e.AccountID); err != nil {
			return PostResult{}, err
		}
		a.balance = newBal
	}

	// Transactional outbox: the event commits if and only if the money movement commits.
	payload, _ := json.Marshal(map[string]any{
		"transaction_id": txnID,
		"description":    in.Description,
		"entries":        in.Entries,
	})
	if _, err := tx.Exec(ctx, `INSERT INTO outbox (topic, payload) VALUES ('ledger.transaction.posted', $1)`, payload); err != nil {
		return PostResult{}, err
	}

	if err := tx.Commit(ctx); err != nil { // the deferred balanced-trigger fires here
		return PostResult{}, err
	}
	return PostResult{TransactionID: txnID}, nil
}

func replay(ctx context.Context, tx pgx.Tx, key, hash string) (PostResult, error) {
	var id, storedHash string
	err := tx.QueryRow(ctx, `SELECT id::text, request_hash FROM transactions WHERE idempotency_key = $1`, key).
		Scan(&id, &storedHash)
	if err != nil {
		return PostResult{}, err
	}
	if storedHash != hash {
		return PostResult{}, ErrIdempotencyConflict
	}
	return PostResult{TransactionID: id, Replayed: true}, nil
}

func validate(in PostInput) error {
	if in.IdempotencyKey == "" || len(in.IdempotencyKey) > 200 {
		return fmt.Errorf("%w: idempotency key required (max 200 chars)", ErrInvalid)
	}
	if len(in.Entries) < 2 {
		return fmt.Errorf("%w: at least two entries required", ErrInvalid)
	}
	var sum int64
	seen := make(map[string]bool, len(in.Entries))
	for _, e := range in.Entries {
		if _, err := uuid.Parse(e.AccountID); err != nil {
			return fmt.Errorf("%w: bad account id %q", ErrInvalid, e.AccountID)
		}
		if seen[e.AccountID] {
			return fmt.Errorf("%w: duplicate account %s", ErrInvalid, e.AccountID)
		}
		seen[e.AccountID] = true
		if e.Amount == 0 || e.Amount > MaxAmount || e.Amount < -MaxAmount {
			return fmt.Errorf("%w: amount out of range", ErrInvalid)
		}
		sum += e.Amount
	}
	if sum != 0 {
		return ErrUnbalanced
	}
	return nil
}

// requestHash is order-independent so a client retrying with shuffled entries still replays cleanly.
func requestHash(in PostInput) string {
	es := append([]Entry(nil), in.Entries...)
	sort.Slice(es, func(i, j int) bool { return es[i].AccountID < es[j].AccountID })
	b, _ := json.Marshal(struct {
		D string  `json:"d"`
		E []Entry `json:"e"`
	}{in.Description, es})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
