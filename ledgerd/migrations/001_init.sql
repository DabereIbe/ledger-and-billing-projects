-- DESIGN NOTES
-- * Amounts are BIGINT minor units (kobo/cents). Never floats: 0.1 + 0.2 != 0.3.
-- * Sign convention: debit = positive, credit = negative. A transaction is valid iff SUM(amount) = 0.
--   One signed column instead of (amount, direction) makes the balance invariant a single SUM.
-- * entries and transactions are append-only (trigger-enforced). Corrections are NEW reversing transactions.
-- * accounts.balance is a cached projection of SUM(entries.amount). Reconciliation proves they agree.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE accounts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code           TEXT        NOT NULL UNIQUE,
    currency       CHAR(3)     NOT NULL,
    allow_negative BOOLEAN     NOT NULL DEFAULT FALSE,   -- true for system accounts (e.g. clearing), false for wallets
    balance        BIGINT      NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT        NOT NULL UNIQUE,
    request_hash    TEXT        NOT NULL,                -- detects same key + different payload
    description     TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE entries (
    id             BIGSERIAL PRIMARY KEY,
    transaction_id UUID        NOT NULL REFERENCES transactions(id),
    account_id     UUID        NOT NULL REFERENCES accounts(id),
    amount         BIGINT      NOT NULL CHECK (amount <> 0),
    balance_after  BIGINT      NOT NULL,                 -- running balance snapshot, great for statements/audits
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX entries_account_idx ON entries (account_id, id);
CREATE INDEX entries_txn_idx     ON entries (transaction_id);

-- Transactional outbox: written in the SAME DB transaction as the ledger entries.
CREATE TABLE outbox (
    id           BIGSERIAL PRIMARY KEY,
    topic        TEXT        NOT NULL,
    payload      JSONB       NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- Defense in depth #1: ledger rows can never be edited or deleted.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER entries_append_only      BEFORE UPDATE OR DELETE ON entries
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER transactions_append_only BEFORE UPDATE OR DELETE ON transactions
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Defense in depth #2: even if application code has a bug, the DB refuses an unbalanced transaction.
-- DEFERRED => checked at COMMIT, after all entries of the transaction are inserted.
CREATE FUNCTION assert_balanced() RETURNS trigger AS $$
BEGIN
    IF (SELECT COALESCE(SUM(amount), 0) FROM entries WHERE transaction_id = NEW.transaction_id) <> 0 THEN
        RAISE EXCEPTION 'transaction % is not balanced', NEW.transaction_id;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_must_balance
    AFTER INSERT ON entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_balanced();
