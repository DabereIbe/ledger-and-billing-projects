package ledger

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type Account struct {
	ID            string `json:"id"`
	Code          string `json:"code"`
	Currency      string `json:"currency"`
	AllowNegative bool   `json:"allow_negative"`
	Balance       int64  `json:"balance"`
}

func (s *Service) CreateAccount(ctx context.Context, code, currency string, allowNegative bool) (Account, error) {
	if code == "" || len(currency) != 3 {
		return Account{}, ErrInvalid
	}
	a := Account{Code: code, Currency: currency, AllowNegative: allowNegative}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO accounts (code, currency, allow_negative) VALUES ($1, $2, $3)
		RETURNING id::text`, code, currency, allowNegative).Scan(&a.ID)
	return a, err
}

func (s *Service) GetAccount(ctx context.Context, id string) (Account, error) {
	var a Account
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, code, currency, allow_negative, balance FROM accounts WHERE id = $1::uuid`, id).
		Scan(&a.ID, &a.Code, &a.Currency, &a.AllowNegative, &a.Balance)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, ErrAccountNotFound
	}
	return a, err
}
