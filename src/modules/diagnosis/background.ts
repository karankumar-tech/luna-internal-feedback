import type { FastifyBaseLogger } from 'fastify';

/**
 * Run work after the HTTP response has been sent.
 * On Vercel, waitUntil() keeps the invocation alive (up to maxDuration). Elsewhere (local dev,
 * tests) the task is scheduled on the event loop of the long-running process.
 */
export async function runInBackground(task: () => Promise<unknown>, log: FastifyBaseLogger, label: string): Promise<void> {
  const wrapped = () => task().catch((err: unknown) => log.error({ err, label }, 'background task failed'));
  if (process.env.VERCEL) {
    try {
      const mod = await import('@vercel/functions');
      mod.waitUntil(wrapped());
      return;
    } catch (err) {
      log.warn({ err }, 'waitUntil unavailable; falling back to setImmediate');
    }
  }
  setImmediate(() => { void wrapped(); });
}
