import test from 'node:test';
import assert from 'node:assert/strict';
import { LibreNmsProvider } from '../src/providers/librenms-provider.mjs';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('normalizes LibreNMS devices without leaking vendor fields', async () => {
  const provider = new LibreNmsProvider({ baseUrl: 'http://librenms.test', token: 'secret', fetchImpl: async () => response({ devices: [{ device_id: 7, hostname: 'edge-01', sysName: 'Edge', status: 1, os: 'ios', community: 'private' }] }) });
  const devices = await provider.listDevices();
  assert.deepEqual(devices, [{ id: '7', name: 'Edge', hostname: 'edge-01', status: 'up', disabled: false, os: 'ios', hardware: '', location: '', lastPolledAt: null }]);
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
