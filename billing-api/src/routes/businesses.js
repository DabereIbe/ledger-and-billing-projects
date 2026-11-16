import { Router } from 'express';
import { Business, Subscription } from '../models/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getLedgerAccount } from '../services/ledgerClient.js';
import { isId } from '../util.js';

const router = Router();

// Owner dashboard numbers. MUST be declared before '/:id' or "me" would be treated as an id.
router.get('/me/summary', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const biz = await Business.findById(req.auth.businessId);
    if (!biz) return res.status(404).json({ error: 'business not found' });

    const [counts, ledger] = await Promise.all([
      Subscription.aggregate([{ $match: { businessId: biz._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      // Degrade gracefully: if the ledger is down the dashboard still loads, just without revenue.
      biz.ledgerRevenueAccountId
        ? getLedgerAccount(biz.ledgerRevenueAccountId).catch((err) => { console.error('ledger unavailable:', err.message); return null; })
        : null,
    ]);

    const subscriptions = { pending: 0, active: 0, past_due: 0, canceled: 0 };
    for (const c of counts) subscriptions[c._id] = c.n;

    res.json({
      businessId: biz._id,
      name: biz.name,
      subscriptions,
      // Revenue is a CREDIT in the ledger, i.e. a negative balance. Flip the sign for display.
      revenueKobo: ledger ? -ledger.balance : null,
      ledgerAvailable: Boolean(ledger),
    });
  } catch (e) { next(e); }
});

// Public, name only: powers the customer invite link (/join/<businessId>). Returns nothing else about the tenant.
// Alternative considered: a public list of all businesses. Rejected, because it enumerates every tenant.
router.get('/:id', async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'not found' });
    const biz = await Business.findById(req.params.id).select('name');
    if (!biz) return res.status(404).json({ error: 'not found' });
    res.json({ id: biz._id, name: biz.name });
  } catch (e) { next(e); }
});

export default router;
