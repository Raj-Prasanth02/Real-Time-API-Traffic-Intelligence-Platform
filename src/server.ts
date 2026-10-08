import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { telemetrySchema } from './domain.js';
import { MemoryTelemetryStore, MongoTelemetryStore } from './store.js';

const app = Fastify({ logger: true });
const store = process.env.NODE_ENV === 'test' ? new MemoryTelemetryStore() : new MongoTelemetryStore();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const thresholds = {
  errorRate: Number(process.env.ERROR_RATE_ALERT_THRESHOLD ?? 0.1),
  latencyMs: Number(process.env.LATENCY_ALERT_THRESHOLD_MS ?? 1000)
};

await app.register(cors, { origin: process.env.CORS_ORIGIN ?? true });
await store.connect();

app.get('/health', async () => ({ status: 'ok', service: 'traffic-intelligence-api', timestamp: new Date().toISOString() }));

app.post('/v1/telemetry', async (request, reply) => {
  const parsed = telemetrySchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid telemetry payload', details: parsed.error.flatten() });
  return reply.code(202).send({ data: await store.add(parsed.data) });
});

app.post('/v1/telemetry/batch', async (request, reply) => {
  const parsed = z.array(telemetrySchema).min(1).max(500).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid telemetry batch', details: parsed.error.flatten() });
  return reply.code(202).send({ accepted: parsed.data.length, data: await store.addMany(parsed.data) });
});

const windowQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  minutes: z.coerce.number().int().min(1).max(10080).default(60)
});

function parseWindow(query: unknown) {
  const parsed = windowQuerySchema.safeParse(query);
  if (!parsed.success) return { error: parsed.error.flatten() } as const;
  const to = parsed.data.to ?? new Date();
  const from = parsed.data.from ?? new Date(to.getTime() - parsed.data.minutes * 60_000);
  return { value: { from, to } } as const;
}

app.get('/v1/metrics/overview', async (request, reply) => {
  const result = parseWindow(request.query);
  if ('error' in result) return reply.code(400).send({ error: 'Invalid time window', details: result.error });
  return { data: await store.overview(result.value) };
});

app.get('/v1/metrics/endpoints', async (request, reply) => {
  const result = parseWindow(request.query);
  if ('error' in result) return reply.code(400).send({ error: 'Invalid time window', details: result.error });
  return { data: await store.endpointMetrics(result.value), window: result.value };
});

app.get('/v1/requests', async (request, reply) => {
  const result = parseWindow(request.query);
  if ('error' in result) return reply.code(400).send({ error: 'Invalid time window', details: result.error });
  const query = request.query as { limit?: string };
  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500);
  return { data: await store.query(result.value, limit), window: result.value };
});

app.get('/v1/alerts', async (request, reply) => {
  const result = parseWindow(request.query);
  if ('error' in result) return reply.code(400).send({ error: 'Invalid time window', details: result.error });
  return { data: await store.alerts(result.value, thresholds), thresholds, window: result.value };
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  return reply.code(500).send({ error: 'Internal server error' });
});

if (process.env.NODE_ENV !== 'test') {
  await app.listen({ port, host });
  process.once('SIGTERM', async () => {
    await app.close();
    await store.close();
  });
}

export { app, store };
