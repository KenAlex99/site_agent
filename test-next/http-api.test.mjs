import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.mjs';
import { MonitoringService } from '../src/monitoring-service.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function fakeProvider() {
  return {
    descriptor: { id: 'fake', name: 'Fake', configured: true },
    async health() { return { status: 'up', provider: this.descriptor }; },
    async listDevices() { return [{ id: '1', name: 'router-1', hostname: 'router-1', status: 'up' }, { id: '2', name: 'switch-1', hostname: 'switch-1', status: 'down' }]; },
    async listPorts() { return [{ id: '9', deviceId: '1', name: 'Gi0/1', status: 'up', rxBps: 1000, txBps: 2000 }]; },
    async listAlerts() { return [{ id: 'a1', state: 'active', severity: 'critical', title: 'Device down' }]; }
  };
}

async function withServer(run) {
  const service = new MonitoringService(fakeProvider(), { clock: () => 1_700_000_000_000, seriesLimit: 2 });
  const app = createApp({ service, publicDir: resolve(packageRoot, 'public-next'), packageRoot, logger: { warn() {} } });
  const server = createServer(app);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((done) => server.close(done)); }
}

test('serves canonical overview with security headers', () => withServer(async (base) => {
  const response = await fetch(`${base}/api/v1/monitoring/overview`, { headers: { 'x-request-id': 'test-1' } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-id'), 'test-1');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(body.devices.up, 1);
  assert.equal(body.devices.down, 1);
  assert.equal(body.alerts.active, 1);
}));

test('serves renderer-neutral traffic series', () => withServer(async (base) => {
  const response = await fetch(`${base}/api/v1/monitoring/series/port-traffic?deviceId=1&portId=9`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.unit, 'bps');
  assert.deepEqual(body.series.map((item) => item.id), ['rx', 'tx']);
  assert.deepEqual(body.series[0].points[0], [1_700_000_000, 1000]);
  assert.equal('chartOptions' in body, false);
}));

test('does not expose a database route', () => withServer(async (base) => {
  assert.equal((await fetch(`${base}/api/v1/monitoring/database`)).status, 404);
}));

test('does not allow static path traversal', () => withServer(async (base) => {
  const response = await fetch(`${base}/%2e%2e/server.mjs`);
  assert.ok([403, 404].includes(response.status));
  assert.equal((await response.text()).includes('LIBRENMS_TOKEN'), false);
}));
