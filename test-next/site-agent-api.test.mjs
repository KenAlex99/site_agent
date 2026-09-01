import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app-insights.mjs';
import { SiteAgentService } from '../src/site-agent-service.mjs';
import { InMemorySiteAgentStore } from '../src/site-agent-store.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const agentToken = 'agent-token-for-site-a-0001';
const viewerTokenA = 'viewer-token-for-tenant-a-01';
const viewerTokenB = 'viewer-token-for-tenant-b-01';

function monitoringService() {
  return {
    async health() { return { status: 'up' }; },
    async overview() { return {}; },
    async devices() { return []; },
    async alerts() { return []; }
  };
}

function siteAgentService() {
  return new SiteAgentService({
    store: new InMemorySiteAgentStore({ clock: () => Date.parse('2026-09-01T10:00:30Z') }),
    agentCredentials: [{ token: agentToken, tenantId: 'tenant-a', siteId: 'site-hk', sourceId: 'librenms-hk-01' }],
    viewerCredentials: [
      { token: viewerTokenA, tenantIds: ['tenant-a'] },
      { token: viewerTokenB, tenantIds: ['tenant-b'] }
    ],
    clock: () => Date.parse('2026-09-01T10:00:30Z')
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

function snapshotBatch(overrides = {}) {
  return {
    schemaVersion: '1.0',
    batchId: 'batch-0001',
    sequence: 1,
    kind: 'snapshot',
    observedAt: '2026-09-01T10:00:00Z',
    devices: [{ localDeviceId: '5', name: 'core-router', hostname: 'core-router', ip: '192.168.110.1', status: 'up' }],
    ports: [{ localPortId: '9', localDeviceId: '5', name: 'Gi0/1', description: 'Uplink', status: 'up', speedBps: 1_000_000_000, rxBps: 80_000, txBps: 40_000 }],
    ...overrides
  };
}

async function request(base, path, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('requires an agent credential and rejects identity spoofing', () => withServer(async (base) => {
  const missing = await request(base, '/api/v1/site-agent/batches', { method: 'POST', body: snapshotBatch() });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).code, 'SITE_AGENT_UNAUTHORIZED');

  const spoofed = await request(base, '/api/v1/site-agent/batches', {
    token: agentToken, method: 'POST', body: snapshotBatch({ tenantId: 'tenant-b' })
  });
  assert.equal(spoofed.status, 403);
  assert.equal((await spoofed.json()).code, 'SITE_AGENT_IDENTITY_MISMATCH');
}));

test('ingests a trusted snapshot and exposes tenant-scoped global identities', () => withServer(async (base) => {
  const uploaded = await request(base, '/api/v1/site-agent/batches', { token: agentToken, method: 'POST', body: snapshotBatch() });
  assert.equal(uploaded.status, 202);
  assert.deepEqual(await uploaded.json(), {
    accepted: true, duplicate: false, applied: true, outOfOrder: false,
    sourceId: 'librenms-hk-01', batchId: 'batch-0001', sequence: 1
  });

  const sources = await request(base, '/api/v1/cloud/monitoring/sources', { token: viewerTokenA });
  assert.equal(sources.status, 200);
  assert.equal((await sources.json()).items[0].tenantId, 'tenant-a');

  const response = await request(base, '/api/v1/cloud/monitoring/sources/librenms-hk-01/snapshot', { token: viewerTokenA });
  const snapshot = await response.json();
  assert.equal(response.status, 200);
  assert.equal(snapshot.siteId, 'site-hk');
  assert.equal(snapshot.freshness, 'fresh');
  assert.equal(snapshot.devices[0].deviceKey, 'librenms-hk-01/device/5');
  assert.equal(snapshot.ports[0].portKey, 'librenms-hk-01/port/9');
  assert.equal(JSON.stringify(snapshot).includes(agentToken), false);
}));

test('handles duplicate and out-of-order batches without replacing the latest snapshot', () => withServer(async (base) => {
  const first = await request(base, '/api/v1/site-agent/batches', { token: agentToken, method: 'POST', body: snapshotBatch({ sequence: 2, batchId: 'batch-0002' }) });
  assert.equal(first.status, 202);

  const duplicate = await request(base, '/api/v1/site-agent/batches', { token: agentToken, method: 'POST', body: snapshotBatch({ sequence: 2, batchId: 'batch-0002' }) });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  const older = await request(base, '/api/v1/site-agent/batches', { token: agentToken, method: 'POST', body: snapshotBatch({
    sequence: 1, batchId: 'batch-older',
    devices: [{ localDeviceId: '99', name: 'old-router', status: 'down' }],
    ports: []
  }) });
  assert.equal(older.status, 202);
  assert.deepEqual(await older.json(), {
    accepted: true, duplicate: false, applied: false, outOfOrder: true,
    sourceId: 'librenms-hk-01', batchId: 'batch-older', sequence: 1
  });

  const snapshot = await (await request(base, '/api/v1/cloud/monitoring/sources/librenms-hk-01/snapshot', { token: viewerTokenA })).json();
  assert.equal(snapshot.sequence, 2);
  assert.equal(snapshot.devices[0].localDeviceId, '5');
}));

test('hides another tenant source and rejects unknown fields that could contain secrets', () => withServer(async (base) => {
  await request(base, '/api/v1/site-agent/batches', { token: agentToken, method: 'POST', body: snapshotBatch() });

  const hidden = await request(base, '/api/v1/cloud/monitoring/sources/librenms-hk-01/snapshot', { token: viewerTokenB });
  assert.equal(hidden.status, 404);

  const secret = await request(base, '/api/v1/site-agent/batches', {
    token: agentToken, method: 'POST',
    body: snapshotBatch({ devices: [{ localDeviceId: '5', name: 'router', status: 'up', snmpCommunity: 'private' }] })
  });
  assert.equal(secret.status, 400);
  assert.equal((await secret.json()).code, 'SITE_AGENT_INVALID_BATCH');
}));
