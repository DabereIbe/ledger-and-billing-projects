package ledger

import (
	"context"
	"fmt"
)

type Discrepancy struct {
	AccountID string
	Cached    int64
	Computed  int64
}

// Reconcile proves two independent invariants:
//  1. For every account, cached balance == SUM(entries). (The cache never drifted.)
//  2. Across the whole ledger, SUM(entries) == 0. (Money is never created or destroyed.)
//
// Run it on a schedule and alert on any non-empty result. This is what "zero balance drift" means on a resume.
func (s *Service) Reconcile(ctx context.Context) ([]Discrepancy, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.id::text, a.balance, COALESCE(SUM(e.amount), 0)::bigint
		FROM accounts a LEFT JOIN entries e ON e.account_id = a.id
		GROUP BY a.id, a.balance
		HAVING a.balance <> COALESCE(SUM(e.amount), 0)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Discrepancy
	for rows.Next() {
		var d Discrepancy
		if err := rows.Scan(&d.AccountID, &d.Cached, &d.Computed); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var total int64
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(SUM(amount), 0)::bigint FROM entries`).Scan(&total); err != nil {
		return nil, err
	}
	if total != 0 {
		return out, fmt.Errorf("GLOBAL INVARIANT BROKEN: entries sum to %d, expected 0", total)
	}
	return out, nil
}
