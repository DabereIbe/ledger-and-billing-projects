import mongoose from 'mongoose';
const { Schema, model } = mongoose;

// ---- Tenancy -------------------------------------------------------------
// Row-level tenancy: every tenant-owned document carries businessId, and every query is scoped by it.
// (Alternatives: database-per-tenant = stronger isolation, costlier ops.)
const Business = model('Business', new Schema({
  name: { type: String, required: true },
  ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
  ledgerRevenueAccountId: String,            // this business's revenue account in the Go ledger
}, { timestamps: true }));

const User = model('User', new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['owner', 'customer'], required: true },
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', index: true },
}, { timestamps: true }));

// ---- Refresh tokens (rotation + reuse detection) -----------------------------
// We store only a HASH of the token: a DB leak must not hand out live sessions.
const RefreshToken = model('RefreshToken', new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  familyId: { type: String, required: true, index: true },   // one login session = one family
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL index auto-purges
  usedAt: Date,                                               // set on rotation; reuse => theft signal
}, { timestamps: true }));

// ---- Billing -----------------------------------------------------------------
const Plan = model('Plan', new Schema({
  businessId: { type: Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true },
  amountKobo: { type: Number, required: true, min: 100 },     // integers only. Never store money as floats.
  interval: { type: String, enum: ['monthly', 'annually'], required: true },
  paystackPlanCode: String,
  active: { type: Boolean, default: true },
}, { timestamps: true }));

export const SUB_STATUS = ['pending', 'active', 'past_due', 'canceled'];

// Explicit state machine: illegal transitions throw instead of silently corrupting state.
const TRANSITIONS = {
  pending: ['active', 'canceled'],
  active: ['past_due', 'canceled', 'active'],   // active -> active = renewal
  past_due: ['active', 'canceled'],
  canceled: [],
};
export function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) throw new Error(`Illegal subscription transition ${from} -> ${to}`);
}

const Subscription = model('Subscription', new Schema({
  businessId: { type: Schema.Types.ObjectId, required: true, index: true },
  customerId: { type: Schema.Types.ObjectId, required: true, index: true },
  customerEmail: { type: String, required: true },
  planId: { type: Schema.Types.ObjectId, required: true },
  planCode: String,
  status: { type: String, enum: SUB_STATUS, default: 'pending' },
  currentPeriodEnd: Date,
  paystackSubscriptionCode: String,
}, { timestamps: true }));

const Payment = model('Payment', new Schema({
  businessId: { type: Schema.Types.ObjectId, required: true, index: true },
  subscriptionId: { type: Schema.Types.ObjectId, required: true, index: true },
  reference: { type: String, required: true, unique: true },  // doubles as the ledger idempotency key
  amountKobo: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'pending' },
}, { timestamps: true }));

// ---- Webhook inbox -----------------------------------------------------------
// Unique eventKey makes duplicate deliveries impossible to process twice.
const WebhookEvent = model('WebhookEvent', new Schema({
  eventKey: { type: String, required: true, unique: true },
  type: String,
  payload: Schema.Types.Mixed,
  status: { type: String, enum: ['received', 'processed', 'failed'], default: 'received' },
  error: String,
}, { timestamps: true }));

export { Business, User, RefreshToken, Plan, Subscription, Payment, WebhookEvent };
