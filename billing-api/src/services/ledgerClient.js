import { config } from '../config.js';

async function ledger(path, { method = 'GET', body, idempotencyKey } = {}) {
  const res = await fetch(`${config.LEDGER_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.LEDGER_API_KEY,
      ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(5000),          // never wait forever on a downstream service
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ledger ${method} ${path} -> ${res.status}: ${json.error ?? 'unknown'}`);
  return json;
}

export async function createLedgerAccount(code, currency, allowNegative) {
  const acct = await ledger('/v1/accounts', { method: 'POST', body: { code, currency, allow_negative: allowNegative } });
  return acct.id;
}

// Safe to call any number of times with the same key: the Go ledger replays instead of double-posting.
export function postLedgerTransaction({ key, description, entries }) {
  return ledger('/v1/transactions', { method: 'POST', idempotencyKey: key, body: { description, entries } });
}

export const getLedgerAccount = (id) => ledger(`/v1/accounts/${id}`);
