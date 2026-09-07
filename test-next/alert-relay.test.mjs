import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AlertRelayService } from '../src/alert-relay-service.mjs';
import { loadAlertRelayConfig } from '../src/alert-relay-config.mjs';

const localToken = 'local-alertmanager-relay-token';

function webhook(overrides = {}) {
  return {
    version: '4', groupKey: '{}:{alertname="DeviceDown"}', status: 'firing', receiver: 'site-agent-relay',
    groupLabels: {}, commonLabels: {}, commonAnnotations: {}, externalURL: 'http://alertmanager:9093',
    alerts: [{
      status: 'firing', labels: { alertname: 'DeviceDown', severity: 'critical', device_id: '5' },
      annotations: { summary: 'Device is down' }, startsAt: '2026-09-04T10:59:00Z',
      endsAt: '0001-01-01T00:00:00Z', generatorURL: '', fingerprint: 'abc123'
    }],
    ...overrides
  };
}

async function withRelay(options, run) {
  const service = new AlertRelayService({
    localToken,
    queue: options.queue || queueStub(),
    worker: options.worker || { async drainOnce() { return { state: 'idle' }; } },
    alertmanagerUrl: 'http://alertmanager:9093',
    fetchImpl: options.fetchImpl || (async () => new Response('[]', { status: 200 })),
    clock: options.clock || (() => Date.parse('2026-09-04T11:00:00Z')),
    logger: { warn() {} }
  });
  const server = createServer(service.handler());
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try { await run(service, `http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((done) => server.close(done)); }
}

test('requires local Bearer authentication and JSON for Alertmanager Webhooks', () => withRelay({}, async (_service, base) => {
  const missing = await fetch(`${base}/api/v1/alertmanager/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(webhook()) });
  assert.equal(missing.status, 401);
  const wrongType = await fetch(`${base}/api/v1/alertmanager/webhook`, { method: 'POST', headers: { authorization: `Bearer ${localToken}`, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
}));

test('durably enqueues before returning 202 and triggers delivery', () => {
  const order = [];
  const queue = queueStub({ async enqueue(payload) { order.push('enqueue'); assert.equal(payload.kind, 'alert-events'); return { queueId: 'q1' }; } });
  const worker = { async drainOnce() { order.push('drain'); return { state: 'delivered' }; } };
  return withRelay({ queue, worker }, async (_service, base) => {
    const response = await fetch(`${base}/api/v1/alertmanager/webhook`, {
      method: 'POST', headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' }, body: JSON.stringify(webhook())
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).queueId, 'q1');
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(order, ['enqueue', 'drain']);
  });
});

test('rejects invalid and oversized Webhooks without enqueueing', () => {
  let enqueued = 0;
  const queue = queueStub({ async enqueue() { enqueued += 1; } });
  return withRelay({ queue }, async (_service, base) => {
    const invalid = await fetch(`${base}/api/v1/alertmanager/webhook`, {
      method: 'POST', headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' }, body: JSON.stringify(webhook({ alerts: [] }))
    });
    assert.equal(invalid.status, 400);
    const oversized = await fetch(`${base}/api/v1/alertmanager/webhook`, {
      method: 'POST', headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) })
    });
    assert.equal(oversized.status, 413);
    assert.equal(enqueued, 0);
  });
});

test('reports queue health and rejects new Webhooks while stopping', () => withRelay({}, async (service, base) => {
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, 'up');
  assert.equal(health.queue.entries, 3);
  await service.stop();
  const response = await fetch(`${base}/api/v1/alertmanager/webhook`, {
    method: 'POST', headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' }, body: JSON.stringify(webhook())
  });
  assert.equal(response.status, 503);
}));

test('polls Alertmanager API v2 and enqueues monotonic active-alert snapshots', () => {
  const payloads = [];
  let now = Date.parse('2026-09-04T11:00:00Z');
  const queue = queueStub({ async enqueue(payload) { payloads.push(payload); return { queueId: `q${payloads.length}` }; } });
  const fetchImpl = async (url) => {
    assert.equal(String(url), 'http://alertmanager:9093/api/v2/alerts');
    return new Response(JSON.stringify([{
      annotations: { summary: 'Device is down' }, endsAt: '0001-01-01T00:00:00Z', fingerprint: 'abc123',
      receivers: [{ name: 'site-agent-relay' }], startsAt: '2026-09-04T10:59:00Z',
      status: { state: 'active', silencedBy: [], inhibitedBy: [] }, updatedAt: '2026-09-04T11:00:00Z',
      generatorURL: '', labels: { alertname: 'DeviceDown', severity: 'critical' }
    }]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return withRelay({ queue, fetchImpl, clock: () => now }, async (service) => {
    await service.pollSnapshot();
    await service.pollSnapshot();
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].sequence, Date.parse('2026-09-04T11:00:00Z'));
    assert.equal(payloads[1].sequence, payloads[0].sequence + 1);
    assert.equal(payloads[0].alerts[0].status, 'firing');
    now += 60_000;
  });
});

test('loads safe relay defaults and rejects secrets placed directly in environment values', () => {
  const config = loadAlertRelayConfig({
    ALERT_CLOUD_URL: 'https://cloud.example', ALERT_CLOUD_TOKEN_FILE: '/run/secrets/cloud_token',
    ALERT_RELAY_TOKEN_FILE: '/run/secrets/webhook_token', ALERT_QUEUE_DIR: '/var/lib/alert-relay/queue'
  });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4312);
  assert.equal(config.snapshotIntervalMs, 60_000);
  assert.throws(() => loadAlertRelayConfig({ ALERT_CLOUD_URL: 'https://cloud.example', ALERT_CLOUD_TOKEN: 'do-not-use-env' }), /TOKEN_FILE/);
  assert.throws(() => loadAlertRelayConfig({
    ALERT_CLOUD_URL: 'http://cloud.example', ALERT_CLOUD_TOKEN_FILE: '/run/secrets/cloud_token',
    ALERT_RELAY_TOKEN_FILE: '/run/secrets/webhook_token', ALERT_QUEUE_DIR: '/var/lib/alert-relay/queue'
  }), /HTTPS/i);
});

function queueStub(overrides = {}) {
  return {
    async enqueue() { return { queueId: 'q-default' }; },
    async stats() { return { entries: 3, bytes: 1024, oldestAgeMs: 5000, maxEntries: 10_000, maxBytes: 256 * 1024 * 1024 }; },
    ...overrides
  };
}
