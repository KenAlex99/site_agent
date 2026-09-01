import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibreNmsProvider } from '../src/providers/librenms-provider-insights.mjs';
import { MonitoringService } from '../src/monitoring-service-insights.mjs';
import { createApp } from '../src/app-insights.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('normalizes global port metrics used by rankings', async () => {
  let requestedUrl = '';
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'secret',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return json({ ports: [{
        port_id: 9, device_id: 2, ifName: 'Gi0/1', ifAlias: 'Uplink', ifOperStatus: 'up', ifAdminStatus: 'up',
        ifSpeed: 1_000_000_000, ifInOctets_rate: 62_500_000, ifOutOctets_rate: 25_000_000,
        ifInErrors_delta: 2, ifOutErrors_delta: 3, poll_time: 1_700_000_000
      }] });
    }
  });
  const ports = await provider.listAllPorts();
  assert.match(requestedUrl, /\/api\/v0\/ports\?columns=/);
  assert.doesNotMatch(requestedUrl, /if(?:In|Out)Bits_rate/);
  assert.doesNotMatch(requestedUrl, /if(?:In|Out)Discards_delta/);
  assert.equal(ports[0].rxBps, 500_000_000);
  assert.equal(ports[0].txBps, 200_000_000);
  assert.equal(ports[0].errors, 5);
  assert.equal(ports[0].discards, 0);
  assert.equal(ports[0].polledAt, '2023-11-14T22:13:20.000Z');
});

test('normalizes device resources, availability and current sensor values', async () => {
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'secret',
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/graphs')) return json({ graphs: [{ name: 'uptime', desc: 'System Uptime' }] });
      if (path.endsWith('/health')) return json({ graphs: [{ name: 'device_temperature', desc: 'Temperature' }] });
      if (path.endsWith('/availability')) return json({ availability: [{ duration: 86400, availability_perc: '99.5' }] });
      if (path.endsWith('/resources/sensors')) return json({ sensors: [{ sensor_id: 17, device_id: 7, sensor_deleted: 0, sensor_descr: 'Outlet', sensor_current: 31.5, sensor_limit: 60, sensor_limit_warn: 50, sensor_class: 'temperature', lastupdate: '2026-08-25 10:00:00' }] });
      throw new Error(`unexpected ${path}`);
    }
  });
  const resources = await provider.listDeviceResources('7');
  assert.deepEqual(resources.availability[0], { durationSeconds: 86400, percent: 99.5 });
  assert.deepEqual(resources.graphs.map((item) => item.id), ['uptime', 'device_temperature']);
  const sensors = await provider.listDeviceResourceSensors('7', 'device_temperature');
  assert.equal(sensors[0].current, 31.5);
  assert.equal(sensors[0].warningHigh, 50);
});

test('normalizes ARP and event log entries', async () => {
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'secret',
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path.includes('/resources/ip/arp/')) return json({ arp: [{ port_id: 9, mac_address: 'aabbccddeeff', ipv4_address: '10.0.0.8', context_name: 'default' }] });
      if (path.includes('/logs/eventlog/')) return json({ logs: [{ event_id: 4, device_id: 2, type: 'interface', message: 'Port Gi0/1 changed state', datetime: '2026-08-25 10:00:00' }] });
      throw new Error(`unexpected ${path}`);
    }
  });
  assert.deepEqual((await provider.listArp('2'))[0], { portId: '9', macAddress: 'aa:bb:cc:dd:ee:ff', ipAddress: '10.0.0.8', context: 'default' });
  const events = await provider.listEventLog('2', { limit: 20 });
  assert.equal(events[0].id, '4');
  assert.equal(events[0].message, 'Port Gi0/1 changed state');
});

test('proxies graph bytes without exposing the upstream token', async () => {
  let auth = '';
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'graph-secret',
    fetchImpl: async (_url, options) => {
      auth = options.headers['X-Auth-Token'];
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { status: 200, headers: { 'content-type': 'image/png' } });
    }
  });
  const graph = await provider.getPortGraph('2', 'Gi0/1', 'port_bits', { from: '-24h', to: 'now', width: 900, height: 260 });
  assert.equal(auth, 'graph-secret');
  assert.equal(graph.contentType, 'image/png');
  assert.deepEqual([...graph.body], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(graph.body.toString().includes('graph-secret'), false);
});

function extendedFakeProvider() {
  const ports = [
    { id: '9', deviceId: '1', name: 'Gi0/1', status: 'up', speedBps: 1_000, rxBps: 800, txBps: 100, errors: 1, discards: 2 },
    { id: '10', deviceId: '2', name: 'Gi0/2', status: 'up', speedBps: 10_000, rxBps: 1_000, txBps: 2_000, errors: 8, discards: 1 }
  ];
  return {
    descriptor: { id: 'fake', name: 'Fake', configured: true },
    async health() { return { status: 'up', provider: this.descriptor }; },
    async listDevices() { return [{ id: '1', name: 'router-1', status: 'up' }, { id: '2', name: 'switch-2', status: 'up' }]; },
    async listPorts(deviceId) { return ports.filter((item) => item.deviceId === deviceId); },
    async listAllPorts() { return ports; },
    async listAlerts() { return []; },
    async listDeviceResources(deviceId) { return { deviceId, graphs: [{ id: 'uptime', name: 'Uptime', category: 'device' }], availability: [] }; },
    async listDeviceResourceSensors() { return []; },
    async getDeviceResourceSeries() { return { id: 'resource:uptime', title: 'Uptime', unit: 's', sampledAt: '2026-09-01T00:00:00Z', sampleMode: 'rrd-xport', series: [{ id: 's1', name: 'uptime', points: [[1_700_000_000, 123]] }] }; },
    async getPortHistorySeries() { return { id: 'port-history:9', title: 'Port history', unit: 'bps', sampledAt: '2026-09-01T00:00:00Z', sampleMode: 'rrd-xport', series: [{ id: 'rx', name: 'Inbound', points: [[1_700_000_000, 800]] }] }; },
    async listArp() { return [{ portId: '9', ipAddress: '10.0.0.8', macAddress: 'aa:bb:cc:dd:ee:ff', context: '' }]; },
    async listEventLog() { return [{ id: 'e1', deviceId: '1', message: 'Gi0/1 down', type: 'interface', timestamp: null }]; },
    async getDeviceGraph() { return { contentType: 'image/png', body: Buffer.from([1, 2, 3]) }; },
    async getPortGraph() { return { contentType: 'image/png', body: Buffer.from([4, 5, 6]) }; }
  };
}

async function withServer(run) {
  const service = new MonitoringService(extendedFakeProvider(), { clock: () => 1_700_000_000_000 });
  const app = createApp({ service, publicDir: resolve(packageRoot, 'public-next'), packageRoot, logger: { warn() {} } });
  const server = createServer(app);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((done) => server.close(done)); }
}

test('serves rankings, resources, renderer-neutral series, ARP and events', () => withServer(async (base) => {
  const ranking = await (await fetch(`${base}/api/v1/monitoring/ports/rankings?metric=utilization&limit=10`)).json();
  assert.deepEqual(ranking.items.map((item) => item.id), ['9', '10']);
  assert.equal(ranking.items[0].utilizationPercent, 80);

  const resources = await (await fetch(`${base}/api/v1/monitoring/devices/1/resources`)).json();
  assert.equal(resources.graphs[0].id, 'uptime');

  const resourceSeries = await (await fetch(`${base}/api/v1/monitoring/devices/1/resources/uptime/series?from=-24h`)).json();
  assert.equal(resourceSeries.sampleMode, 'rrd-xport');

  const portSeries = await (await fetch(`${base}/api/v1/monitoring/devices/1/ports/9/series?from=-6h`)).json();
  assert.equal(portSeries.unit, 'bps');

  const arp = await (await fetch(`${base}/api/v1/monitoring/devices/1/ports/9/arp`)).json();
  assert.equal(arp.items.length, 1);

  const events = await (await fetch(`${base}/api/v1/monitoring/devices/1/events?limit=20`)).json();
  assert.equal(events.items[0].id, 'e1');

}));

test('keeps Notes and database access outside the read-only module', () => withServer(async (base) => {
  assert.equal((await fetch(`${base}/api/v1/monitoring/devices/1/notes`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/monitoring/database`)).status, 404);
}));
