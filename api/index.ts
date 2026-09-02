// Vercel serverless entry. vercel.json rewrites every path here; Fastify does the routing.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/app.js';

const app = buildApp({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const ready = app.ready();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await ready;
  app.server.emit('request', req, res);
}
