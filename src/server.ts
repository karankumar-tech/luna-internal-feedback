// Entrypoint for both `npm start` and Vercel.
// Vercel's Fastify preset detects src/server.ts because it imports `fastify` directly,
// then intercepts app.listen() and runs the app as one Function.
import Fastify from 'fastify';
import { buildApp } from './build-app.js';

const app = buildApp({ fastify: Fastify });

try {
  await app.listen({ port: app.config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}
