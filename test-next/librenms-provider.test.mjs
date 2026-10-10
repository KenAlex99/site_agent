import test from 'node:test';
import assert from 'node:assert/strict';
import { LibreNmsProvider } from '../src/providers/librenms-provider.mjs';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('normalizes LibreNMS devices without leaking vendor fields', async () => {
  const provider = new LibreNmsProvider({ baseUrl: 'http://librenms.test', token: 'secret', fetchImpl: async () => response({ devices: [{ device_id: 7, hostname: 'edge-01', sysName: 'Edge', status: 1, os: 'ios', community: 'private' }] }) });
  const devices = await provider.listDevices();
  assert.deepEqual(devices, [{ id: '7', name: 'Edge', hostname: 'edge-01', ipAddress: '', status: 'up', disabled: false, os: 'ios', hardware: '', location: '', uptimeSeconds: null, lastPolledAt: null }]);
  assert.equal('community' in devices[0], false);
});

test('normalizes octet rates to bits per second', async () => {
  let requestedUrl = '';
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'secret',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return response({ ports: [{ port_id: 11, device_id: 7, ifName: 'Gi0/1', ifOperStatus: 'up', ifAdminStatus: 'up', ifInOctets_rate: 125, ifOutOctets_rate: 250 }] });
    }
  });
  const ports = await provider.listPorts('edge-01');
  assert.equal(ports[0].rxBps, 1000);
  assert.equal(ports[0].txBps, 2000);
  assert.doesNotMatch(requestedUrl, /if(?:In|Out)Bits_rate/);
});

test('does not include the API token in upstream errors', async () => {
  const provider = new LibreNmsProvider({ baseUrl: 'http://librenms.test', token: 'top-secret', fetchImpl: async () => response({ message: 'unauthorized top-secret' }, 401) });
  await assert.rejects(() => provider.listAlerts(), (error) => {
    assert.equal(error.code, 'MONITORING_PROVIDER_REJECTED');
    assert.equal(error.message.includes('top-secret'), false);
    return true;
  });
});

test('rejects unsafe identifiers before an upstream request', async () => {
  let called = false;
  const provider = new LibreNmsProvider({ baseUrl: 'http://librenms.test', token: 'secret', fetchImpl: async () => { called = true; return response({}); } });
  await assert.rejects(() => provider.listPorts('../../admin'), { code: 'MONITORING_INVALID_ARGUMENT' });
  assert.equal(called, false);
});

test('rejects alert history ranges longer than 31 days before requesting LibreNMS', async () => {
  let called = false;
  const provider = new LibreNmsProvider({ baseUrl: 'http://librenms.test', token: 'secret', fetchImpl: async () => { called = true; return response({}); } });
  await assert.rejects(() => provider.listAlertHistory({ from: '2026-01-01T00:00:00Z', to: '2026-02-02T00:00:01Z' }), { code: 'MONITORING_INVALID_ARGUMENT' });
  assert.equal(called, false);
});

test('queries and normalizes a bounded LibreNMS alertlog page', async () => {
  let requestedUrl = '';
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'secret', timeZone: 'Asia/Shanghai',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return response({ total: 1, logs: [{ id: 91, device_id: 7, hostname: 'edge-01', rule_id: 12, name: 'Device down', severity: 'critical', state: 1, time_logged: '2026-09-15T01:02:03Z', details: 'SNMP polling failed', community: 'private' }] });
    }
  });
  const result = await provider.listAlertHistory({ from: '2026-09-01T00:00:00Z', to: '2026-09-16T00:00:00Z', page: 2, pageSize: 25, deviceId: '7' });
  assert.match(requestedUrl, /\/api\/v0\/logs\/alertlog\/7\?/);
  assert.match(requestedUrl, /start=25/);
  assert.match(requestedUrl, /limit=25/);
  const query = new URL(requestedUrl).searchParams;
  assert.equal(query.get('from'), '2026-09-01 08:00:00');
  assert.equal(query.get('to'), '2026-09-16 08:00:00');
  assert.deepEqual(result, {
    items: [{ id: '91', deviceId: '7', deviceName: 'edge-01', ruleId: '12', title: 'Device down', severity: 'critical', state: 'active', occurredAt: '2026-09-15T01:02:03.000Z', description: 'SNMP polling failed' }],
    page: 2, pageSize: 25, total: 1
  });
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('enriches real alertlog rows from one rules request and never stringifies detail objects', async () => {
  const requestedUrls = [];
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'secret', timeZone: 'Asia/Shanghai',
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).endsWith('/api/v0/rules')) {
        return response({ rules: [{ id: 12, name: 'Device status changed', severity: 'warning', notes: 'private operator note', query: 'secret query' }] });
      }
      return response({ total: 2, logs: [
        { id: 91, device_id: 7, hostname: 'edge-01', rule_id: 12, state: 1, time_logged: '2026-09-15T01:02:03Z', details: { rule: [{ device_id: 7, hostname: 'edge-01', community: 'private' }] } },
        { id: 92, device_id: 7, hostname: 'edge-01', rule_id: 12, state: 0, time_logged: '2026-09-15T01:03:03Z', details: { rule: [] } }
      ] });
    }
  });

  const result = await provider.listAlertHistory({ from: '2026-09-15T00:00:00Z', to: '2026-09-16T00:00:00Z', deviceId: '7' });

  assert.equal(requestedUrls.filter((url) => url.endsWith('/api/v0/rules')).length, 1);
  assert.deepEqual(result.items.map(({ title, severity, description }) => ({ title, severity, description })), [
    { title: 'Device status changed', severity: 'warning', description: '' },
    { title: 'Device status changed', severity: 'warning', description: '' }
  ]);
  assert.doesNotMatch(JSON.stringify(result), /\[object Object\]|private operator note|secret query|community|private/);
});

test('converts naive LibreNMS alertlog timestamps back to UTC', async () => {
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'secret', timeZone: 'Asia/Shanghai',
    fetchImpl: async () => response({ logs: [{ id: 93, device_id: 7, name: 'Link down', state: 1, time_logged: '2026-09-17 08:15:30' }] })
  });

  const result = await provider.listAlertHistory({ from: '2026-09-16T16:00:00Z', to: '2026-09-17T16:00:00Z' });

  assert.equal(result.items[0].occurredAt, '2026-09-17T00:15:30.000Z');
});

test('supports half-hour source zones without using a fixed offset', async () => {
  let requestedUrl = '';
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'secret', timeZone: 'Asia/Kolkata',
    fetchImpl: async (url) => { requestedUrl = String(url); return response({ logs: [] }); }
  });

  await provider.listAlertHistory({ from: '2026-09-16T18:30:00Z', to: '2026-09-17T18:30:00Z' });

  const query = new URL(requestedUrl).searchParams;
  assert.equal(query.get('from'), '2026-09-17 00:00:00');
  assert.equal(query.get('to'), '2026-09-18 00:00:00');
});

test('uses the earlier instant for an ambiguous DST fold and rejects a DST gap', async () => {
  const rows = [
    { id: 94, device_id: 7, name: 'Fold', state: 1, time_logged: '2026-11-01 01:30:00' },
    { id: 95, device_id: 7, name: 'Gap', state: 1, time_logged: '2026-03-08 02:30:00' }
  ];
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'secret', timeZone: 'America/New_York',
    fetchImpl: async () => response({ logs: [rows.shift()] })
  });

  const folded = await provider.listAlertHistory({ from: '2026-10-31T00:00:00Z', to: '2026-11-02T00:00:00Z' });
  assert.equal(folded.items[0].occurredAt, '2026-11-01T05:30:00.000Z');
  await assert.rejects(
    () => provider.listAlertHistory({ from: '2026-03-07T00:00:00Z', to: '2026-03-09T00:00:00Z' }),
    { code: 'MONITORING_PROVIDER_INVALID_RESPONSE' }
  );
});

test('requires a valid IANA zone only when alert history is queried', async () => {
  let called = false;
  const missing = new LibreNmsProvider({ baseUrl: 'http://librenms.test', token: 'secret', fetchImpl: async () => { called = true; return response({}); } });
  const invalid = new LibreNmsProvider({ baseUrl: 'http://librenms.test', token: 'secret', timeZone: 'UTC+8', fetchImpl: async () => { called = true; return response({}); } });

  await assert.rejects(
    () => missing.listAlertHistory({ from: '2026-09-16T00:00:00Z', to: '2026-09-17T00:00:00Z' }),
    { code: 'MONITORING_PROVIDER_NOT_CONFIGURED' }
  );
  await assert.rejects(
    () => invalid.listAlertHistory({ from: '2026-09-16T00:00:00Z', to: '2026-09-17T00:00:00Z' }),
    { code: 'MONITORING_PROVIDER_NOT_CONFIGURED' }
  );
  assert.equal(called, false);
});

test('reads one device and returns only projected non-sensitive attributes', async () => {
  let requestedUrl = '';
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'transport-secret',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return response({ devices: [{ device_id: 7, hostname: 'edge-01', hardware: 'C9300', community: 'private', authalgo: 'SHA' }] });
    }
  });
  const result = await provider.getDeviceAttributes('edge-01', { fields: new Set(['hostname', 'hardware', 'community']) });
  assert.match(requestedUrl, /\/api\/v0\/devices\/edge-01$/);
  assert.deepEqual(result.items.map((item) => item.key), ['hardware', 'hostname']);
  assert.doesNotMatch(JSON.stringify(result), /private|transport-secret/);
});
