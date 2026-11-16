import { z } from 'zod';

// Fail fast at boot: a missing secret should crash the deploy, not surface as a 500 at 2am.
const schema = z.object({
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  MONGO_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  PAYSTACK_SECRET_KEY: z.string().min(1),
  CALLBACK_URL: z.string().url(),
  LEDGER_URL: z.string().url(),
  LEDGER_API_KEY: z.string().min(1),
  LEDGER_CLEARING_ACCOUNT_ID: z.string().min(1),
});

export const config = schema.parse(process.env);
