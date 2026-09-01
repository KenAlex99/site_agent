import test from 'node:test';
import assert from 'node:assert/strict';
import { LibreNmsProvider } from '../src/providers/librenms-provider-insights.mjs';

test('rejects SVG or other active graph content even when upstream returns 200', async () => {
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'secret',
    fetchImpl: async () => new Response('<svg><script>alert(1)</script></svg>', { status: 200, headers: { 'content-type': 'image/svg+xml' } })
  });
  await assert.rejects(
    () => provider.getDeviceGraph('1', 'health', 'device_temperature'),
    { code: 'MONITORING_PROVIDER_INVALID_RESPONSE' }
  );
});

test('rejects unsafe graph types before contacting LibreNMS', async () => {
  let called = false;
  const provider = new LibreNmsProvider({
    baseUrl: 'http://librenms.test', token: 'secret',
    fetchImpl: async () => { called = true; return new Response(); }
  });
  await assert.rejects(
    () => provider.getDeviceGraph('1', 'health', '../../admin'),
    { code: 'MONITORING_INVALID_ARGUMENT' }
  );
  assert.equal(called, false);
});
