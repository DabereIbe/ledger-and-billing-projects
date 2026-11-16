# Billing platform: Go double-entry ledger + MERN subscription billing

A multi-tenant subscription billing app (businesses create plans, customers subscribe and pay through
Paystack) backed by a separate Go service that records every payment as an immutable, balanced,
idempotent double-entry transaction.

> Built as a portfolio project to practise payment-system design: webhook security, idempotency,
> concurrency control, and consistency across two databases.

## Architecture

```mermaid
flowchart LR
    UI["React frontend<br/>(Vite, Tailwind, daisyUI)"] -->|REST + JWT| API["billing-api<br/>(Express, Mongoose)"]
    PS["Paystack"] -->|signed webhooks| API
    API -->|checkout / plans| PS
    API --> M[("MongoDB<br/>replica set")]
    API -->|"HTTP + API key<br/>Idempotency-Key"| L["ledgerd<br/>(Go, chi, pgx)"]
    L --> P[("PostgreSQL")]
    L -.->|transactional outbox| E["event consumers<br/>(stub: logs)"]
```

### Payment flow

```mermaid
sequenceDiagram
    participant C as Customer (browser)
    participant B as billing-api
    participant PS as Paystack
    participant L as ledgerd
    C->>B: POST /subscriptions (planId)
    B->>PS: initialize transaction (reference)
    B-->>C: checkoutUrl
    C->>PS: pays on hosted checkout
    PS->>B: POST /webhooks/paystack (charge.success, HMAC-SHA512)
    B->>B: verify signature, store event, Mongo transaction: payment succeeded + subscription active
    B->>L: POST /v1/transactions (Idempotency-Key = paystack-charge:reference)
    PS-->>C: redirect to /billing/callback
    C->>B: poll /subscriptions/by-reference/:ref until active
```

The browser redirect never activates anything. Only the verified webhook does; the callback page waits for it.

## Repository layout

| Folder | What it is |
|---|---|
| `ledgerd/` | Go ledger service: accounts, balanced transactions, idempotency, outbox, reconciliation |
| `billing-api/` | Node/Express API: auth, tenancy, plans, subscriptions, Paystack integration |
| `frontend/` | React app: owner dashboard, customer plans, checkout callback |

## Key design decisions

**Ledger (`ledgerd`)**
- Money is `BIGINT` minor units (kobo), never floats.
- One signed `amount` column (debit positive, credit negative); a transaction is valid when its entries sum to zero.
- `entries` and `transactions` are append-only, enforced by database triggers. A deferred constraint trigger rejects unbalanced transactions at commit, as a second line of defence behind the service check.
- Idempotency: `INSERT ... ON CONFLICT DO NOTHING` on a unique key, plus a request hash so the same key with a different payload returns 409. A replay returns 200 with an `Idempotent-Replay` header.
- Concurrency: `READ COMMITTED` with `SELECT ... FOR UPDATE ORDER BY id`, so funds checks see current balances and opposite-direction transfers cannot deadlock.
- Balances are a cached projection of the entries. A reconciliation job (every minute) checks that each cached balance equals the sum of its entries and that all entries sum to zero.
- Transactional outbox: events commit atomically with the money movement and are relayed at-least-once. The publisher is currently a log stub.

**Billing (`billing-api`)**
- Webhook signature is HMAC-SHA512 over the raw request body, compared in constant time. The route is mounted before `express.json()` for that reason.
- Inbox pattern: each webhook is stored (unique hash) before processing, so redeliveries are ignored and failures keep their error text for debugging.
- Response codes drive Paystack's retries: 401 bad signature, 500 transient failure (retry wanted), 200 for duplicates and unrecoverable events.
- A Mongo transaction updates payment and subscription together. The ledger call is outside it (two databases, no shared transaction) and is idempotent on the payment reference, so a failed attempt converges on retry.
- Explicit subscription state machine; illegal transitions throw.
- Auth: 15-minute stateless access JWT, rotating httpOnly refresh cookie stored hashed, reuse of a rotated token kills the whole session family.
- Multi-tenancy by `businessId` taken from the verified token, never from the request body.

## Running locally

**Requirements:** Go 1.22+, Node 20.6+, Docker Desktop. Commands below are PowerShell; on bash, use `export VAR=value`.

Adjust the host ports below if they clash with services already on your machine (Postgres 5432, Mongo 27017).

### 1. Ledger

```powershell
cd ledgerd
go mod tidy
docker compose up -d db          # applies migrations/001_init.sql on first boot

$env:DATABASE_URL = "postgres://ledger:ledger@localhost:5433/ledger"
$env:LEDGER_API_KEY = "dev-key-change-me"
go run ./cmd/ledgerd             # listens on :8080
```

Create the platform clearing account once and keep the returned `id`:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8080/v1/accounts `
  -Headers @{ "X-API-Key" = "dev-key-change-me" } -ContentType "application/json" `
  -Body '{"code":"paystack-clearing","currency":"NGN","allow_negative":true}'
```

> `docker compose down -v` deletes the ledger data. Stored account IDs in billing's database will then point at accounts that no longer exist.

### 2. Billing API

MongoDB **must be a replica set** (subscription activation uses a transaction). The included compose file runs a single-node replica set:

```powershell
cd billing-api
docker compose up -d             # wait ~15s for the replica set to initialise
copy .env.example .env           # then edit the values below
npm install
npm run dev                      # listens on :4000
```

| Variable | Notes |
|---|---|
| `MONGO_URL` | e.g. `mongodb://localhost:27018/billing?directConnection=true` for the compose Mongo |
| `JWT_ACCESS_SECRET` | at least 32 random characters |
| `PAYSTACK_SECRET_KEY` | Paystack **test** secret key (`sk_test_...`) |
| `CALLBACK_URL` | `http://localhost:5173/billing/callback` |
| `CORS_ORIGIN` | frontend origin, default `http://localhost:5173` |
| `LEDGER_URL` | `http://localhost:8080` |
| `LEDGER_API_KEY` | must equal the key `ledgerd` was started with |
| `LEDGER_CLEARING_ACCOUNT_ID` | the `id` returned when you created the clearing account |

### 3. Frontend

```powershell
cd frontend
npm install
npm run dev                      # http://localhost:5173
```

Set `VITE_API_URL` if the API is not at `http://localhost:4000`.

### 4. Webhooks in development

Paystack cannot reach `localhost`. Run `ngrok http 4000`, then set the webhook URL in the Paystack dashboard (**test mode**) to `https://<your-id>.ngrok-free.app/webhooks/paystack`. Only payments made after saving the URL are delivered. The ngrok inspector at `http://127.0.0.1:4040` shows each delivery and its response code.

### Try it

1. Register a business owner and create a plan.
2. Open the invite link in a private window and register a customer.
3. Subscribe and pay with one of Paystack's test cards.
4. The subscription turns active and the owner dashboard shows revenue read from the ledger.

## Tests

```powershell
cd ledgerd
$env:DATABASE_URL = "postgres://ledger:ledger@localhost:5433/ledger"
go test ./... -v
```

The Go tests run against a real Postgres: 50 concurrent requests with one idempotency key, 500 concurrent transfers between shared wallets (checking no negative balance, no money created or destroyed, clean reconciliation), and rejection of unbalanced transactions. There are no automated tests for `billing-api` or the frontend yet.

## API summary

**ledgerd** (header `X-API-Key`): `POST /v1/accounts`, `GET /v1/accounts/{id}`, `POST /v1/transactions` (header `Idempotency-Key`), `GET /healthz`

**billing-api**: `POST /auth/register|login|refresh|logout`, `GET /auth/me`, `GET|POST /plans`, `POST /subscriptions`, `GET /subscriptions` (owner), `GET /subscriptions/mine`, `GET /subscriptions/by-reference/:reference`, `GET /businesses/:id` (public), `GET /businesses/me/summary`, `POST /webhooks/paystack`, `GET /health`

## Known limitations

- Paystack's processing fee is not recorded; the ledger books the full payment as revenue.
- Registering an owner creates the business before the ledger account, so a ledger failure can leave an orphan business.
- Abandoned checkouts leave `pending` subscriptions indefinitely.
- Webhooks are processed inline rather than through a queue.
- Nothing verifies that every stored ledger account ID still exists in the ledger.
- Hot-row contention: every payment locks the shared clearing account, which caps throughput. Sharding it into sub-accounts or batching postings would address this.
- The outbox publisher logs instead of publishing to a broker.
- Single static API key between services; no per-client keys or mTLS.
- The refresh cookie is `SameSite=Strict`, so the frontend and API must share a site (or the cookie settings must change) when deployed on separate domains.
- Not deployed, and no CI yet.

## Security notes

Secrets live in `.env` files, which are git-ignored; commit only `.env.example`. Use Paystack **test** keys for development.
