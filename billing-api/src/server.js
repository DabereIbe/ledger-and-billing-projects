import mongoose from 'mongoose';
import { config } from './config.js';
import { createApp } from './app.js';

await mongoose.connect(config.MONGO_URL);
const server = createApp().listen(config.PORT, () => console.log(`billing-api on :${config.PORT}`));

// Graceful shutdown: stop accepting connections, finish in-flight webhooks, then close the DB.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(async () => { await mongoose.disconnect(); process.exit(0); }));
}
