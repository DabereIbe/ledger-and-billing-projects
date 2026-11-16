import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { User, Business, RefreshToken } from '../models/index.js';
import { signAccessToken, requireAuth } from '../middleware/auth.js';
import { isId } from '../util.js';
import { createLedgerAccount } from '../services/ledgerClient.js';

const router = Router();
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const cookieOpts = {
  httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict',
  path: '/auth', maxAge: REFRESH_TTL_MS,
};

// SHA-256 (not bcrypt) is correct for refresh tokens: they are 256 bits of randomness, not guessable passwords.
async function issueRefresh(userId, familyId = crypto.randomUUID()) {
  const raw = crypto.randomBytes(48).toString('base64url');
  await RefreshToken.create({ userId, familyId, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) });
  return raw;
}

const registerSchema = z.object({
  email: z.string().email(), password: z.string().min(10),
  role: z.enum(['owner', 'customer']),
  businessName: z.string().min(2).optional(),   // owners create a business
  businessId: z.string().optional(),            // customers join one
});

router.post('/register', async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(body.password, 12);
    let businessId = body.businessId;
    let user;
    if (body.role === 'owner') {
      if (!body.businessName) return res.status(400).json({ error: 'businessName required' });
      const biz = await Business.create({ name: body.businessName });
      biz.ledgerRevenueAccountId = await createLedgerAccount(`biz-${biz._id}-revenue`, 'NGN', true);
      await biz.save();
      user = await User.create({ email: body.email, passwordHash, role: 'owner', businessId: biz._id });
      biz.ownerId = user._id; await biz.save();
    } else {
      // Previously unchecked: a bogus id would have created an orphan customer, and a malformed one a CastError (500).
      if (!isId(businessId) || !(await Business.exists({ _id: businessId }))) {
        return res.status(404).json({ error: 'business not found' });
      }
      user = await User.create({ email: body.email, passwordHash, role: 'customer', businessId });
    }
    res.status(201).json({ id: user._id });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'email already registered' });
    next(e);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const user = await User.findOne({ email: email.toLowerCase() });
    // Same message and same work whether the email or the password was wrong: no user enumeration.
    const ok = user && await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    res.cookie('refresh', await issueRefresh(user._id), cookieOpts);
    res.json({ accessToken: signAccessToken(user) });
  } catch (e) { next(e); }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const raw = req.cookies?.refresh;
    if (!raw) return res.status(401).json({ error: 'no refresh token' });
    const rec = await RefreshToken.findOne({ tokenHash: sha256(raw) });
    if (!rec || rec.expiresAt < new Date()) return res.status(401).json({ error: 'invalid refresh token' });

    // Atomically claim the token. If two requests race, only ONE gets a non-null result.
    const claimed = await RefreshToken.findOneAndUpdate({ _id: rec._id, usedAt: null }, { usedAt: new Date() });
    if (!claimed) {
      // Token already used => either a bug or a stolen token being replayed. Kill the whole session family.
      await RefreshToken.deleteMany({ familyId: rec.familyId });
      return res.status(401).json({ error: 'refresh token reuse detected; please log in again' });
    }
    const user = await User.findById(rec.userId);
    res.cookie('refresh', await issueRefresh(rec.userId, rec.familyId), cookieOpts);
    res.json({ accessToken: signAccessToken(user) });
  } catch (e) { next(e); }
});

// The frontend calls this after login and after every silent refresh to learn who it is.
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.auth.userId).select('email role businessId');
    if (!user) return res.status(401).json({ error: 'user no longer exists' });
    const biz = user.businessId ? await Business.findById(user.businessId).select('name') : null;
    res.json({
      id: user._id, email: user.email, role: user.role,
      businessId: user.businessId, businessName: biz?.name ?? null,
    });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res) => {
  const raw = req.cookies?.refresh;
  if (raw) {
    const rec = await RefreshToken.findOne({ tokenHash: sha256(raw) });
    if (rec) await RefreshToken.deleteMany({ familyId: rec.familyId });
  }
  res.clearCookie('refresh', { path: '/auth' }).status(204).end();
});

export default router;
