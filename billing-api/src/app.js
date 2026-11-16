import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import { config } from './config.js';
import { ZodError } from 'zod';
import authRoutes from './routes/auth.js';
import planRoutes from './routes/plans.js';
import subRoutes from './routes/subscriptions.js';
import webhookRoutes from './routes/webhooks.js';
import businessRoutes from './routes/businesses.js';

export function createApp() {
  const app = express();
  app.use(helmet());

  // ORDER MATTERS: the webhook needs the RAW bytes for signature verification, so it must be mounted
  // BEFORE express.json(), which would consume and re-parse the body.
  app.use('/webhooks', express.raw({ type: 'application/json', limit: '1mb' }), webhookRoutes);

  // CORS comes AFTER the webhook mount on purpose: Paystack is a server, not a browser, and needs no CORS.
  // credentials:true lets the browser send the refresh cookie; that REQUIRES a specific origin, never '*'.
  app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/auth', rateLimit({ windowMs: 15 * 60_000, limit: 50, standardHeaders: true }), authRoutes);
  app.use('/businesses', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true }), businessRoutes);
  app.use('/plans', planRoutes);
  app.use('/subscriptions', subRoutes);

  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'validation', issues: err.issues });
    console.error(err);
    res.status(500).json({ error: 'internal error' });   // never leak stack traces or driver messages
  });
  return app;
}
