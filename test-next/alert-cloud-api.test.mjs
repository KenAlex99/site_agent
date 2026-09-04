import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app-insights.mjs';
import { SiteAgentService } from '../src/site-agent-service.mjs';
import { InMemorySiteAgentStore } from '../src/site-agent-store.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const agentToken = 'agent-token-for-alert-tests-001';
const viewerTokenA = 'viewer-token-for-alert-tenant-a';
const viewerTokenB = 'viewer-token-for-alert-tenant-b';

function monitoringService() {
  return { async health() { return { status: 'up' }; } };
}

function siteAgentService() {
  return new SiteAgentService({
    store: new InMemorySiteAgentStore({ clock: () => Date.parse('2026-09-04T06:01:00Z') }),
    agentCredentials: [{ token: agentToken, tenantId: 'tenant-a', siteId: 'site-hk', sourceId: 'librenms-hk-01' }],
    viewerCredentials: [
      { token: viewerTokenA, tenantIds: ['tenant-a'] },
      { token: viewerTokenB, tenantIds: ['tenant-b'] }
    ],
    clock: () => Date.parse('2026-09-04T06:01:00Z')
  });
}

async function withServer(run) {
  const app = createApp({
    service: monitoringService(), siteAgentService: siteAgentService(),
    publicDir: resolve(packageRoot, 'public-next'), packageRoot,
    logger: { warn() {} }
  });
  const server = createServer(app);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((done) => server.close(done)); }
}

function alert(overrides = {}) {
  return {
    fingerprint: 'abc123', status: 'firing', startsAt: '2026-09-04T06:00:00Z',
    labels: { alertname: 'DeviceDown', severity: 'critical', device_id: '5' },
    annotations: { summary: 'Core router is down' },
    ...overrides
  };
}

function eventBatch(overrides = {}) {
  return {
    schemaVersion: '1.0', deliveryId: 'delivery-0001', kind: 'alert-events',
    observedAt: '2026-09-04T06:00:10Z', status: 'firing', groupKey: 'device-down',
    receiver: 'site-agent-relay', alerts: [alert()], ...overrides
  };
}

function snapshotBatch(overrides = {}) {
  return {
    schemaVersion: '1.0', snapshotId: 'snapshot-0001', sequence: 1,
    kind: 'alert-snapshot', observedAt: '2026-09-04T06:00:30Z', alerts: [alert()],
    ...overrides
  };
}

async function request(base, path, { token, method = 'GET', body, rawBody } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method, headers,
    body: rawBody === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : rawBody
  });
}

test('authenticates alert event ingestion and rejects identity spoofing', () => withServer(async (base) => {
  const missing = await request(base, '/api/v1/site-agent/alert-events', { method: 'POST', body: eventBatch() });
  assert.equal(missing.status, 401);

  const spoofed = await request(base, '/api/v1/site-agent/alert-events', {
    token: agentToken, method: 'POST', body: eventBatch({ tenantId: 'tenant-b' })
  });
  assert.equal(spoofed.status, 403);
  assert.equal((await spoofed.json()).code, 'SITE_AGENT_IDENTITY_MISMATCH');
}));

test('stores alert events idempotently with tenant-scoped global alert keys', () => withServer(async (base) => {
  const first = await request(base, '/api/v1/site-agent/alert-events', { token: agentToken, method: 'POST', body: eventBatch() });
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    accepted: true, duplicate: false, sourceId: 'librenms-hk-01', deliveryId: 'delivery-0001', alertCount: 1
  });

  const duplicate = await request(base, '/api/v1/site-agent/alert-events', { token: agentToken, method: 'POST', body: eventBatch() });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  const visible = await request(base, '/api/v1/cloud/monitoring/sources/librenms-hk-01/alert-events?limit=20', { token: viewerTokenA });
  assert.equal(visible.status, 200);
  const body = await visible.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].tenantId, 'tenant-a');
  assert.equal(body.items[0].alerts[0].alertKey, 'librenms-hk-01/alert/abc123');
  assert.equal(JSON.stringify(body).includes(agentToken), false);

  const hidden = await request(base, '/api/v1/cloud/monitoring/sources/librenms-hk-01/alert-events', { token: viewerTokenB });
  assert.equal(hidden.status, 404);
}));

test('applies the latest alert snapshot and protects it from older sequences', () => withServer(async (base) => {
  const latest = await request(base, '/api/v1/site-agent/alert-snapshots', {
    token: agentToken, method: 'POST', body: snapshotBatch({ sequence: 2, snapshotId: 'snapshot-0002' })
  });
  assert.equal(latest.status, 202);
  assert.equal((await latest.json()).applied, true);

  const older = await request(base, '/api/v1/site-agent/alert-snapshots', {
    token: agentToken, method: 'POST', body: snapshotBatch({ sequence: 1, snapshotId: 'snapshot-older', alerts: [] })
  });
  assert.equal(older.status, 202);
  assert.equal((await older.json()).outOfOrder, true);

  const response = await request(base, '/api/v1/cloud/monitoring/sources/librenms-hk-01/alerts', { token: viewerTokenA });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.sequence, 2);
  assert.equal(snapshot.alerts.length, 1);
  assert.equal(snapshot.alerts[0].alertKey, 'librenms-hk-01/alert/abc123');
}));

test('rejects unknown or sensitive alert fields and oversized requests', () => withServer(async (base) => {
  const sensitive = await request(base, '/api/v1/site-agent/alert-events', {
    token: agentToken, method: 'POST',
    body: eventBatch({ alerts: [alert({ labels: { alertname: 'DeviceDown', api_token: 'do-not-store' } })] })
  });
  assert.equal(sensitive.status, 400);
  assert.equal((await sensitive.json()).code, 'SITE_AGENT_INVALID_ALERT_BATCH');

  const unknown = await request(base, '/api/v1/site-agent/alert-events', {
    token: agentToken, method: 'POST', body: eventBatch({ rawPayload: { secret: true } })
  });
  assert.equal(unknown.status, 400);

  const oversized = await request(base, '/api/v1/site-agent/alert-events', {
    token: agentToken, method: 'POST', rawBody: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) })
  });
  assert.equal(oversized.status, 413);
}));
