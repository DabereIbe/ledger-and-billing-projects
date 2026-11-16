import { Router } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Subscription, Payment, Plan, Business, WebhookEvent, assertTransition } from '../models/index.js';
import { verifyWebhookSignature } from '../services/paystack.js';
import { postLedgerTransaction } from '../services/ledgerClient.js';
import { config } from '../config.js';

const router = Router();

// The handler's contract with Paystack:
//   2xx => "got it, stop retrying".  non-2xx => "retry later" (Paystack retries for ~3 days).
// So: 401 for bad signatures, 500 for transient failures we WANT retried, 200 for duplicates and unfixable events.
router.post('/paystack', async (req, res) => {
  const raw = req.body; // Buffer, thanks to express.raw() mounted in app.js
  if (!verifyWebhookSignature(raw, req.headers['x-paystack-signature'])) {
    return res.status(401).json({ error: 'bad signature' });
  }
  const event = JSON.parse(raw.toString('utf8'));

  // Inbox pattern: record first, process second. The unique index dedupes redeliveries.
  // Paystack has no event id, so identical bytes == the same delivery.
  const eventKey = crypto.createHash('sha256').update(raw).digest('hex');
  let rec;
  try {
    rec = await WebhookEvent.create({ eventKey, type: event.event, payload: event });
  } catch (e) {
    if (e.code !== 11000) return res.sendStatus(500);
    rec = await WebhookEvent.findOne({ eventKey });
    if (rec.status === 'processed') return res.sendStatus(200);   // already done
    // 'received' or 'failed' => fall through and (re)process. Handlers are idempotent, so this is safe.
  }

  try {
    const outcome = await handleEvent(event);
    rec.status = outcome === 'ok' ? 'processed' : 'failed';
    rec.error = outcome === 'ok' ? undefined : outcome;
    await rec.save();
    // 'unmatched' / 'amount_mismatch' will never succeed on retry: ack it and alert a human instead.
    return res.sendStatus(200);
  } catch (err) {
    rec.status = 'failed'; rec.error = String(err.message).slice(0, 500);
    await rec.save();
    return res.sendStatus(500);                                    // transient (DB / ledger down): retry me
  }
});

async function handleEvent({ event, data }) {
  switch (event) {
    case 'charge.success': return applyCharge(data);
    case 'subscription.create': return linkSubscription(data);
    case 'invoice.payment_failed': return markPastDue(data);
    case 'subscription.disable':
    case 'subscription.not_renew': return cancel(data);
    default: return 'ok'; // ignore events we don't care about, but still ack them
  }
}

async function matchSubscription(d) {
  const code = d.subscription_code ?? d.subscription?.subscription_code;
  if (code) {
    const s = await Subscription.findOne({ paystackSubscriptionCode: code });
    if (s) return s;
  }
  const email = d.customer?.email?.toLowerCase();
  const planCode = d.plan?.plan_code ?? d.subscription?.plan?.plan_code;
  if (!email || !planCode) return null;
  return Subscription.findOne({ customerEmail: email, planCode, status: { $in: ['pending', 'active', 'past_due'] } })
    .sort('-createdAt');
}

function nextPeriodEnd(from, interval) {
  const d = new Date(from);
  if (interval === 'annually') d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1);
  return d;
}

async function applyCharge(d) {
  const existing = await Payment.findOne({ reference: d.reference });
  const sub = existing ? await Subscription.findById(existing.subscriptionId) : await matchSubscription(d); // renewals have no pre-made Payment
  if (!sub) return 'unmatched';
  const plan = await Plan.findById(sub.planId);
  // Never trust amounts blindly: compare to what the plan says it should cost.
  if (d.amount !== plan.amountKobo || d.currency !== 'NGN') return 'amount_mismatch';

  // Mongo transaction: payment + subscription change together or not at all.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const r = await Payment.updateOne(
        { reference: d.reference },
        { $set: { status: 'succeeded' },
          $setOnInsert: { businessId: sub.businessId, subscriptionId: sub._id, amountKobo: d.amount } },
        { upsert: true, session },
      );
      const firstTime = r.upsertedCount > 0 || r.modifiedCount > 0;   // false on a replay => don't extend twice
      if (!firstTime) return;
      const fresh = await Subscription.findById(sub._id).session(session);
      assertTransition(fresh.status, 'active');
      const base = fresh.currentPeriodEnd && fresh.currentPeriodEnd > new Date() ? fresh.currentPeriodEnd : new Date();
      fresh.status = 'active';
      fresh.currentPeriodEnd = nextPeriodEnd(base, plan.interval);
      await fresh.save({ session });
    });
  } finally { await session.endSession(); }

  // Ledger write happens OUTSIDE the Mongo transaction (two databases, no shared transaction).
  // It is idempotent on the payment reference, so if it fails we return 500, Paystack retries, and we converge.
  const biz = await Business.findById(sub.businessId);
  await postLedgerTransaction({
    key: `paystack-charge:${d.reference}`,
    description: `Subscription payment ${d.reference}`,
    entries: [
      { account_id: config.LEDGER_CLEARING_ACCOUNT_ID, amount: d.amount },     // debit: cash held at Paystack
      { account_id: biz.ledgerRevenueAccountId, amount: -d.amount },           // credit: revenue earned
    ],
  });
  return 'ok';
}

async function linkSubscription(d) {
  const sub = await matchSubscription(d);
  if (!sub) return 'unmatched';
  await Subscription.updateOne({ _id: sub._id }, { paystackSubscriptionCode: d.subscription_code });
  return 'ok';
}

async function markPastDue(d) {
  const sub = await matchSubscription(d);
  if (!sub) return 'unmatched';
  if (sub.status === 'active') { assertTransition(sub.status, 'past_due'); sub.status = 'past_due'; await sub.save(); }
  return 'ok';
}

async function cancel(d) {
  const sub = await matchSubscription(d);
  if (!sub) return 'unmatched';
  if (sub.status !== 'canceled') { assertTransition(sub.status, 'canceled'); sub.status = 'canceled'; await sub.save(); }
  return 'ok';
}

export default router;
