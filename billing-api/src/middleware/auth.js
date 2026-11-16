import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// Stateless access tokens (15 min) mean no DB hit per request. The trade-off is that revocation waits for expiry.
// Refresh tokens (stateful, rotated) cover the long-lived part of the session.
export function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, biz: user.businessId ? String(user.businessId) : null },
    config.JWT_ACCESS_SECRET,
    { expiresIn: '15m', algorithm: 'HS256' },
  );
}

export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    // Pin the algorithm: never let the token header choose it.
    const claims = jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    req.auth = { userId: claims.sub, role: claims.role, businessId: claims.biz };
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.auth?.role) ? next() : res.status(403).json({ error: 'forbidden' });
