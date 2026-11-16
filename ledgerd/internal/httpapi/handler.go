package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/DabereIbe/ledgerd/internal/ledger"
)

type API struct {
	Svc    *ledger.Service
	APIKey string
	Log    *slog.Logger
}

func (a *API) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.Recoverer, a.logRequests)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })

	r.Group(func(r chi.Router) {
		r.Use(a.requireKey)
		r.Post("/v1/accounts", a.createAccount)
		r.Get("/v1/accounts/{id}", a.getAccount)
		r.Post("/v1/transactions", a.postTransaction)
	})
	return r
}

func (a *API) postTransaction(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Description string         `json:"description"`
		Entries     []ledger.Entry `json:"entries"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed JSON")
		return
	}
	res, err := a.Svc.Post(r.Context(), ledger.PostInput{
		IdempotencyKey: r.Header.Get("Idempotency-Key"), // header, not body: same convention as Stripe
		Description:    body.Description,
		Entries:        body.Entries,
	})
	if err != nil {
		a.mapError(w, err)
		return
	}
	status := http.StatusCreated
	if res.Replayed {
		status = http.StatusOK
		w.Header().Set("Idempotent-Replay", "true")
	}
	writeJSON(w, status, map[string]any{"transaction_id": res.TransactionID})
}

func (a *API) createAccount(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code          string `json:"code"`
		Currency      string `json:"currency"`
		AllowNegative bool   `json:"allow_negative"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed JSON")
		return
	}
	acct, err := a.Svc.CreateAccount(r.Context(), body.Code, body.Currency, body.AllowNegative)
	if err != nil {
		a.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, acct)
}

func (a *API) getAccount(w http.ResponseWriter, r *http.Request) {
	acct, err := a.Svc.GetAccount(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, acct)
}

// mapError turns domain errors into stable HTTP semantics. Unknown errors are logged, never leaked.
func (a *API) mapError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ledger.ErrInvalid), errors.Is(err, ledger.ErrUnbalanced), errors.Is(err, ledger.ErrCurrencyMismatch):
		writeErr(w, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, ledger.ErrInsufficientFunds):
		writeErr(w, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, ledger.ErrAccountNotFound):
		writeErr(w, http.StatusNotFound, err.Error())
	case errors.Is(err, ledger.ErrIdempotencyConflict):
		writeErr(w, http.StatusConflict, err.Error())
	default:
		a.Log.Error("internal error", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
	}
}

func (a *API) requireKey(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-API-Key")
		if subtle.ConstantTimeCompare([]byte(got), []byte(a.APIKey)) != 1 {
			writeErr(w, http.StatusUnauthorized, "invalid api key")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *API) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		a.Log.Info("request",
			"method", r.Method, "path", r.URL.Path, "status", ww.Status(),
			"ms", time.Since(start).Milliseconds(), "request_id", middleware.GetReqID(r.Context()))
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
