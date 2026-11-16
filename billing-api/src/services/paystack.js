import crypto from 'node:crypto';
import { config } from '../config.js';

async function paystack(path, body) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  if (!res.ok || !json.status) throw new Error(`paystack ${path}: ${json.message ?? res.status}`);
  return json.data;
}

export const createPlan = ({ name, amountKobo, interval }) =>
  paystack('/plan', { name, amount: amountKobo, interval });

export const initializeTransaction = ({ email, amountKobo, reference, planCode, metadata }) =>
  paystack('/transaction/initialize', {
    email, amount: amountKobo, reference, plan: planCode, metadata, callback_url: config.CALLBACK_URL,
  });

// Paystack signs the RAW request body with HMAC-SHA512 using your secret key.
// Hashing re-serialized JSON would break the signature, which is why the webhook route uses express.raw().
export function verifyWebhookSignature(rawBody, signature) {
  if (!signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha512', config.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);   // constant-time compare
}
