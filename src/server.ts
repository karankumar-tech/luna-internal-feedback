// Entrypoint for both `npm start` and Vercel.
// Vercel's Fastify preset detects src/server.ts because it imports `fastify` directly,
// then intercepts app.listen() and runs the app as one Function.
import Fastify from 'fastify';
import { buildApp } from './build-app.js';

let app: ReturnType<typeof buildApp>;
try {
  app = buildApp({ fastify: Fastify });
} catch (err) {
  // Typically a missing env var; make it obvious in platform logs.
  console.error('[startup] failed to build app:', err instanceof Error ? err.message : err);
  process.exit(1);
}

app.listen({ port: app.config.PORT, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err, 'listen failed');
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}
