import { Router } from 'express';
import { z } from 'zod';
import { Plan } from '../models/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createPlan } from '../services/paystack.js';

const router = Router();
router.use(requireAuth);

router.post('/', requireRole('owner'), async (req, res, next) => {
  try {
    const body = z.object({
      name: z.string().min(2), amountKobo: z.number().int().min(100),
      interval: z.enum(['monthly', 'annually']),
    }).parse(req.body);
    const ps = await createPlan(body);
    const plan = await Plan.create({ ...body, businessId: req.auth.businessId, paystackPlanCode: ps.plan_code });
    res.status(201).json(plan);
  } catch (e) { next(e); }
});

// Tenant scoping on EVERY query: businessId comes from the verified token, never from the request body.
router.get('/', async (req, res, next) => {
  try {
    res.json(await Plan.find({ businessId: req.auth.businessId, active: true }));
  } catch (e) { next(e); }
});

export default router;
