import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { Plan, Subscription, Payment, User } from '../models/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { initializeTransaction } from '../services/paystack.js';

const router = Router();
router.use(requireAuth);

// Customer starts a subscription. We create PENDING rows first, then send them to Paystack checkout.
// Nothing becomes "active" here: only a verified webhook can activate. (Never trust the browser redirect.)
router.post('/', requireRole('customer'), async (req, res, next) => {
  try {
    const { planId } = z.object({ planId: z.string() }).parse(req.body);
    // Scoped lookup: a customer cannot subscribe to another business's plan by guessing ids.
    const plan = await Plan.findOne({ _id: planId, businessId: req.auth.businessId, active: true });
    if (!plan) return res.status(404).json({ error: 'plan not found' });
    const user = await User.findById(req.auth.userId);

    const sub = await Subscription.create({
      businessId: plan.businessId, customerId: user._id, customerEmail: user.email,
      planId: plan._id, planCode: plan.paystackPlanCode,
    });
    const reference = `sub_${crypto.randomUUID()}`;
    await Payment.create({
      businessId: plan.businessId, subscriptionId: sub._id, reference, amountKobo: plan.amountKobo,
    });
    const init = await initializeTransaction({
      email: user.email, amountKobo: plan.amountKobo, reference, planCode: plan.paystackPlanCode,
      metadata: { subscriptionId: String(sub._id) },
    });
    res.status(201).json({ subscriptionId: sub._id, checkoutUrl: init.authorization_url });
  } catch (e) { next(e); }
});

// The checkout callback page only knows the `reference` Paystack puts in the redirect URL. It polls this
// until status becomes 'active'. The redirect itself proves nothing: only the verified webhook activates.
// 404 for both "doesn't exist" and "not yours" so references can't be probed.
router.get('/by-reference/:reference', requireRole('customer'), async (req, res, next) => {
  try {
    const payment = await Payment.findOne({ reference: String(req.params.reference) });
    const sub = payment && await Subscription.findOne({ _id: payment.subscriptionId, customerId: req.auth.userId });
    if (!sub) return res.status(404).json({ error: 'not found' });
    res.json({
      subscriptionId: sub._id, status: sub.status,
      paymentStatus: payment.status, currentPeriodEnd: sub.currentPeriodEnd,
    });
  } catch (e) { next(e); }
});

router.get('/mine', requireRole('customer'), async (req, res, next) => {
  try { res.json(await Subscription.find({ customerId: req.auth.userId })); } catch (e) { next(e); }
});

router.get('/', requireRole('owner'), async (req, res, next) => {
  try { res.json(await Subscription.find({ businessId: req.auth.businessId }).sort('-createdAt').limit(100)); }
  catch (e) { next(e); }
});

export default router;
