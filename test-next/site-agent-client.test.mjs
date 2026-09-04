import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadSiteAgentClientConfig,
  runSiteAgentOnce
} from '../src/site-agent-client.mjs';

const token = 'agent-token-for-client-test-0001';

test('validates and normalizes Site Agent environment configuration', () => {
  assert.throws(
    () => loadSiteAgentClientConfig({ SITE_AGENT_CLOUD_URL: 'http://127.0.0.1:4311' }),
    /SITE_AGENT_TOKEN/
  );
  assert.throws(
    () => loadSiteAgentClientConfig({ SITE_AGENT_CLOUD_URL: 'not-a-url', SITE_AGENT_TOKEN: token }),
    /SITE_AGENT_CLOUD_URL/
  );

  assert.deepEqual(loadSiteAgentClientConfig({
    SITE_AGENT_CLOUD_URL: 'http://127.0.0.1:4311/',
    SITE_AGENT_LOCAL_URL: 'http://127.0.0.1:4310/',
    SITE_AGENT_TOKEN: token,
    SITE_AGENT_SEQUENCE: '42',
    SITE_AGENT_TIMEOUT_MS: '9000',
    SITE_AGENT_PAGE_SIZE: '2'
  }), {
    cloudUrl: 'http://127.0.0.1:4311',
    localUrl: 'http://127.0.0.1:4310',
    token,
    sequence: 42,
    timeoutMs: 9000,
    pageSize: 2
  });
});

test('collects every port page, maps allowed fields, and uploads one trusted snapshot', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/monitoring/devices') {
      return json(200, { items: [
        {
          id: '5', name: 'core-router', hostname: '192.0.2.5', status: 'up', disabled: false,
          os: 'ios', hardware: 'C9300', location: 'HK-A', lastPolledAt: '2026-09-03T01:00:00.000Z', ignored: 'not-uploaded'
        },
        { id: '6', name: 'disabled-switch', hostname: 'switch.internal', status: 'down', disabled: true }
      ] });
    }
    if (parsed.pathname === '/api/v1/monitoring/ports') {
      const page = Number(parsed.searchParams.get('page'));
      assert.equal(parsed.searchParams.get('pageSize'), '2');
      if (page === 1) return json(200, { total: 3, page: 1, pageSize: 2, items: [
        {
          id: '9', deviceId: '5', name: 'Gi0/1', description: 'Uplink', status: 'up', adminStatus: 'up',
          speedBps: 1_000_000_000, rxBps: 80_000, txBps: 40_000, errors: 2, discards: 1,
          polledAt: '2026-09-03T01:00:00.000Z', trafficBps: 120_000, deviceName: 'core-router'
        },
        { id: '10', deviceId: '5', name: 'Gi0/2', description: '', status: 'down', adminStatus: 'down', speedBps: null }
      ] });
      if (page === 2) return json(200, { total: 3, page: 2, pageSize: 2, items: [
        { id: '11', deviceId: '6', name: 'Eth1', status: 'unexpected-state', adminStatus: 'up', rxBps: 0, txBps: 0 }
      ] });
    }
    if (parsed.pathname === '/api/v1/site-agent/batches') {
      const body = JSON.parse(options.body);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      assert.equal(options.headers['content-type'], 'application/json');
      assert.deepEqual(body, {
        schemaVersion: '1.0', batchId: 'batch-fixed-uuid', sequence: 42, kind: 'snapshot',
        observedAt: '2026-09-03T01:02:03.000Z',
        devices: [
          {
            localDeviceId: '5', name: 'core-router', hostname: '192.0.2.5', ip: '192.0.2.5', status: 'up',
            os: 'ios', hardware: 'C9300', location: 'HK-A', polledAt: '2026-09-03T01:00:00.000Z'
          },
          { localDeviceId: '6', name: 'disabled-switch', hostname: 'switch.internal', status: 'disabled' }
        ],
        ports: [
          {
            localPortId: '9', localDeviceId: '5', name: 'Gi0/1', description: 'Uplink', status: 'up', adminStatus: 'up',
            speedBps: 1_000_000_000, rxBps: 80_000, txBps: 40_000, errors: 2, discards: 1,
            polledAt: '2026-09-03T01:00:00.000Z'
          },
          { localPortId: '10', localDeviceId: '5', name: 'Gi0/2', status: 'down', adminStatus: 'down' },
          { localPortId: '11', localDeviceId: '6', name: 'Eth1', status: 'unknown', adminStatus: 'up', rxBps: 0, txBps: 0 }
        ]
      });
      return json(202, { accepted: true, duplicate: false, applied: true, sourceId: 'librenms-hk-01' });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await runSiteAgentOnce({
    cloudUrl: 'http://127.0.0.1:4311', localUrl: 'http://127.0.0.1:4310', token,
    sequence: 42, timeoutMs: 9000, pageSize: 2
  }, {
    fetchImpl,
    clock: () => Date.parse('2026-09-03T01:02:03.000Z'),
    uuid: () => 'batch-fixed-uuid'
  });

  assert.deepEqual(result, {
    accepted: true, duplicate: false, applied: true, sourceId: 'librenms-hk-01',
    batchId: 'batch-fixed-uuid', sequence: 42, deviceCount: 2, portCount: 3
  });
  assert.equal(requests.filter(({ url }) => url.includes('/monitoring/ports?')).length, 2);
});

test('rejects an invalid local response before any upload', async () => {
  let uploaded = false;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/monitoring/devices') return json(200, { devices: [] });
    if (path === '/api/v1/site-agent/batches') uploaded = true;
    return json(200, { total: 0, items: [] });
  };

  await assert.rejects(
    runSiteAgentOnce(config(), { fetchImpl, clock: () => 1_788_400_000_000, uuid: () => 'batch-invalid' }),
    /devices response/
  );
  assert.equal(uploaded, false);
});

test('reports cloud rejection without including the credential', async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/monitoring/devices') return json(200, { items: [] });
    if (path === '/api/v1/monitoring/ports') return json(200, { total: 0, page: 1, pageSize: 200, items: [] });
    return json(401, { code: 'SITE_AGENT_UNAUTHORIZED', message: 'credential rejected' });
  };

  await assert.rejects(runSiteAgentOnce(config(), { fetchImpl }), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes(token), false);
    return true;
  });
});

function config() {
  return {
    cloudUrl: 'http://127.0.0.1:4311', localUrl: 'http://127.0.0.1:4310', token,
    sequence: 42, timeoutMs: 15_000, pageSize: 200
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
