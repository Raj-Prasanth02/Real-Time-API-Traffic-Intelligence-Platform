import assert from 'node:assert/strict';
import test from 'node:test';
import { app, store } from '../src/server.js';

test('ingests telemetry and reports endpoint metrics', async () => {
  const timestamp = new Date().toISOString();
  const response = await app.inject({
    method: 'POST',
    url: '/v1/telemetry',
    payload: { service: 'checkout-api', method: 'POST', path: '/orders', statusCode: 201, durationMs: 148, timestamp }
  });

  assert.equal(response.statusCode, 202);
  assert.equal(response.json().data.service, 'checkout-api');

  const metrics = await app.inject({ method: 'GET', url: '/v1/metrics/endpoints?minutes=5' });
  assert.equal(metrics.statusCode, 200);
  assert.equal(metrics.json().data[0].requestCount, 1);
  assert.equal(metrics.json().data[0].errorRate, 0);
});

test('rejects malformed telemetry', async () => {
  const response = await app.inject({ method: 'POST', url: '/v1/telemetry', payload: { method: 'GET' } });
  assert.equal(response.statusCode, 400);
});

test.after(async () => {
  await app.close();
  void store;
});
