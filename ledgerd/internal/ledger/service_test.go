package ledger_test

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/DabereIbe/ledgerd/internal/ledger"
)

// Integration tests against a real Postgres (docker compose up db). Mocks cannot test row locking.
// Run: DATABASE_URL=postgres://ledger:ledger@localhost:5432/ledger go test ./... -race

func setup(t *testing.T) (*ledger.Service, context.Context) {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return ledger.NewService(pool), ctx
}

func TestIdempotencyUnderConcurrency(t *testing.T) {
	svc, ctx := setup(t)
	sfx := fmt.Sprint(rand.Int63())
	treasury, _ := svc.CreateAccount(ctx, "treasury-"+sfx, "NGN", true)
	wallet, _ := svc.CreateAccount(ctx, "wallet-"+sfx, "NGN", false)

	in := ledger.PostInput{
		IdempotencyKey: "same-key-" + sfx,
		Description:    "fund wallet",
		Entries: []ledger.Entry{
			{AccountID: treasury.ID, Amount: -5000},
			{AccountID: wallet.ID, Amount: 5000},
		},
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	created, replayed := 0, 0
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := svc.Post(ctx, in)
			if err != nil {
				t.Errorf("post: %v", err)
				return
			}
			mu.Lock()
			defer mu.Unlock()
			if res.Replayed {
				replayed++
			} else {
				created++
			}
		}()
	}
	wg.Wait()

	if created != 1 || replayed != 49 {
		t.Fatalf("want 1 created / 49 replayed, got %d / %d", created, replayed)
	}
	got, _ := svc.GetAccount(ctx, wallet.ID)
	if got.Balance != 5000 {
		t.Fatalf("wallet balance = %d, want 5000 (applied more than once?)", got.Balance)
	}
}

func TestConcurrentTransfersPreserveInvariants(t *testing.T) {
	svc, ctx := setup(t)
	sfx := fmt.Sprint(rand.Int63())
	treasury, _ := svc.CreateAccount(ctx, "t-"+sfx, "NGN", true)

	const nWallets = 5
	wallets := make([]ledger.Account, nWallets)
	for i := range wallets {
		wallets[i], _ = svc.CreateAccount(ctx, fmt.Sprintf("w%d-%s", i, sfx), "NGN", false)
		_, err := svc.Post(ctx, ledger.PostInput{
			IdempotencyKey: fmt.Sprintf("seed-%d-%s", i, sfx), Description: "seed",
			Entries: []ledger.Entry{{AccountID: treasury.ID, Amount: -10_000}, {AccountID: wallets[i].ID, Amount: 10_000}},
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	// 500 random transfers, many A->B and B->A at once: would deadlock without ordered locking.
	var wg sync.WaitGroup
	for i := 0; i < 500; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			a, b := rand.Intn(nWallets), rand.Intn(nWallets)
			if a == b {
				return
			}
			amt := int64(rand.Intn(3000) + 1)
			_, err := svc.Post(ctx, ledger.PostInput{
				IdempotencyKey: fmt.Sprintf("xfer-%d-%s", i, sfx), Description: "transfer",
				Entries: []ledger.Entry{{AccountID: wallets[a].ID, Amount: -amt}, {AccountID: wallets[b].ID, Amount: amt}},
			})
			if err != nil && !errorsIsInsufficient(err) {
				t.Errorf("unexpected error: %v", err)
			}
		}(i)
	}
	wg.Wait()

	var total int64
	for _, w := range wallets {
		got, _ := svc.GetAccount(ctx, w.ID)
		if got.Balance < 0 {
			t.Fatalf("wallet %s went negative: %d", w.ID, got.Balance)
		}
		total += got.Balance
	}
	if total != nWallets*10_000 {
		t.Fatalf("money created/destroyed: wallets hold %d, want %d", total, nWallets*10_000)
	}
	bad, err := svc.Reconcile(ctx)
	if err != nil || len(bad) != 0 {
		t.Fatalf("reconcile failed: %v %v", bad, err)
	}
}

func TestRejectsUnbalanced(t *testing.T) {
	svc, ctx := setup(t)
	sfx := fmt.Sprint(rand.Int63())
	a, _ := svc.CreateAccount(ctx, "ua-"+sfx, "NGN", true)
	b, _ := svc.CreateAccount(ctx, "ub-"+sfx, "NGN", true)
	_, err := svc.Post(ctx, ledger.PostInput{
		IdempotencyKey: "bad-" + sfx, Description: "x",
		Entries: []ledger.Entry{{AccountID: a.ID, Amount: -100}, {AccountID: b.ID, Amount: 99}},
	})
	if err == nil {
		t.Fatal("expected unbalanced error")
	}
}

func errorsIsInsufficient(err error) bool { return errors.Is(err, ledger.ErrInsufficientFunds) }
