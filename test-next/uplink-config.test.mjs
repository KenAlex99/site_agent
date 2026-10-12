import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUplinkIdentityConfig } from '../src/uplink-config.mjs';

test('loads only the opaque Center-issued edge identity', () => {
  assert.deepEqual(loadUplinkIdentityConfig({
    SITE_AGENT_EDGE_ID: 'opaque-center-id',
    HOSTNAME: 'edge-host-a',
    SITE_NAME: 'Beijing',
    SITE_AGENT_LOCAL_URL: 'http://192.0.2.10:4310'
  }), { edgeId: 'opaque-center-id' });

  assert.deepEqual(loadUplinkIdentityConfig({
    SITE_AGENT_EDGE_ID: 'opaque-center-id',
    HOSTNAME: 'renamed-host',
    SITE_NAME: 'Shanghai',
    SITE_AGENT_LOCAL_URL: 'http://198.51.100.20:4310'
  }), { edgeId: 'opaque-center-id' });
});

test('rejects missing, normalized, controlled or oversized edge identities', () => {
  assert.throws(() => loadUplinkIdentityConfig({}), /SITE_AGENT_EDGE_ID/);
  assert.throws(() => loadUplinkIdentityConfig({ SITE_AGENT_EDGE_ID: ' site-a ' }), /SITE_AGENT_EDGE_ID/);
  assert.throws(() => loadUplinkIdentityConfig({ SITE_AGENT_EDGE_ID: 'site\u0000a' }), /SITE_AGENT_EDGE_ID/);
  assert.throws(() => loadUplinkIdentityConfig({ SITE_AGENT_EDGE_ID: 'x'.repeat(129) }), /SITE_AGENT_EDGE_ID/);
  assert.throws(() => loadUplinkIdentityConfig({ SITE_AGENT_EDGE_ID: 42 }), /SITE_AGENT_EDGE_ID/);
});
