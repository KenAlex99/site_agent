import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { prepareLocalUplinkDelivery } from '../src/uplink-local-client.mjs';

const edgeId = 'opaque-center-test-edge';
const envelope = () => ({
  module: 'monitoring', edge_id: edgeId, type: 'alert',
  ts: '2026-10-14T03:18:25.123Z', idempotency_key: 'local-delivery-example-01',
  source_identity: { edge_id: edgeId, system: 'librenms', object_type: 'device',
    identifier_kind: 'librenms_device_id', external_id: '42' },
  payload: { status: 'firing' }
});
const ack = (res, deduplicated = false) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ deduplicated }));
};

async function withReceiver(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try { await run(`http://127.0.0.1:${server.address().port}/ingest`); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('requires explicit send and returns only local durable acknowledgement', async () => {
  let requests = 0;
  await withReceiver((req, res) => {
    requests++;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/ingest');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers['content-type'], 'application/json');
    ack(res);
  }, async (receiverUrl) => {
    const delivery = prepareLocalUplinkDelivery(envelope(), { edgeId, receiverUrl });
    assert.equal(requests, 0);
    assert.equal(Object.isFrozen(delivery), true);
    assert.deepEqual(await delivery.send(), { acceptedLocally: true, deduplicated: false });
    assert.equal(requests, 1);
  });
});

test('freezes payload time and idempotency bytes across explicit resends', async () => {
  const bodies = [];
  await withReceiver((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      if (bodies.length === 1) req.socket.destroy();
      else ack(res, true);
    });
  }, async (receiverUrl) => {
    const input = envelope();
    const expected = JSON.stringify(input);
    const delivery = prepareLocalUplinkDelivery(input, { edgeId, receiverUrl });
    input.payload.status = 'changed';
    input.ts = '2026-10-14T04:18:25.123Z';
    input.idempotency_key = 'changed-after-preparation';
    await assert.rejects(delivery.send(), { code: 'UPLINK_LOCAL_TRANSPORT' });
    assert.deepEqual(await delivery.send(), { acceptedLocally: true, deduplicated: true });
    assert.deepEqual(bodies, [expected, expected]);
  });
});

test('rejects noncanonical, nonloopback, credential-bearing and alternate endpoints before I/O', () => {
  for (const receiverUrl of [
    'http://localhost:9099/ingest', 'https://127.0.0.1:9099/ingest',
    'http://192.0.2.1:9099/ingest', 'http://127.1:9099/ingest',
    'http://2130706433:9099/ingest', 'http://127.0.0.1:0/ingest',
    'http://127.0.0.1:65536/ingest', 'http://127.0.0.1:9099/other',
    'http://127.0.0.1:9099/x/../ingest', 'http://127.0.0.1:9099/ingest?q=x',
    'http://127.0.0.1:9099/ingest#x', 'http://user:example@127.0.0.1:9099/ingest',
    'http://[::ffff:127.0.0.1]:9099/ingest', ' http://127.0.0.1:9099/ingest'
  ]) {
    assert.throws(() => prepareLocalUplinkDelivery(envelope(), { edgeId, receiverUrl }),
      { code: 'UPLINK_LOCAL_CONFIG' });
  }
  assert.doesNotThrow(() => prepareLocalUplinkDelivery(envelope(), {
    edgeId, receiverUrl: 'http://[::1]:9099/ingest'
  }));
});

test('rejects invalid envelopes, identities and configuration before I/O without echoing input', () => {
  for (const input of [ { ...envelope(), type: 'metric' }, { ...envelope(), type: 'command' },
    { ...envelope(), edge_id: 'other-edge' }, { ...envelope(), payload: { text: 'x'.repeat(262144) } } ]) {
    assert.throws(() => prepareLocalUplinkDelivery(input, { edgeId }), (error) => {
      assert.equal(error.code, 'UPLINK_INVALID_ENVELOPE');
      assert.equal(error.message.includes('other-edge'), false);
      return true;
    });
  }
  for (const options of [ {}, { edgeId, timeoutMs: 0 }, { edgeId, timeoutMs: 120001 },
    { edgeId, timeoutMs: NaN }, { edgeId, timeoutMs: 1.5 }, { edgeId, token: 'not-a-credential' } ]) {
    assert.throws(() => prepareLocalUplinkDelivery(envelope(), options));
  }
});

test('does not follow redirects or accept other HTTP statuses including capacity and conflict', async () => {
  for (const status of [202, 204, 302, 307, 400, 401, 403, 409, 429, 500]) {
    let requests = 0;
    await withReceiver((req, res) => {
      requests++;
      res.writeHead(status, { 'content-type': 'application/json', location: '/ingest' });
      res.end('{"deduplicated":false}');
    }, async (receiverUrl) => {
      await assert.rejects(prepareLocalUplinkDelivery(envelope(), { edgeId, receiverUrl }).send(),
        { code: 'UPLINK_LOCAL_REJECTED', httpStatus: status });
      assert.equal(requests, 1);
    });
  }
});

test('requires a complete closed acknowledgement with exactly one boolean member', async () => {
  for (const body of [ '', 'null', '[]', '{}', '{"deduplicated":"false"}',
    '{"deduplicated":false,"extra":true}', '{"deduplicated":false,"deduplicated":true}',
    '{"deduplicated":false} trailing', '{"error":{"message":"untrusted-response-marker"}}' ]) {
    await withReceiver((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    }, async (receiverUrl) => {
      await assert.rejects(prepareLocalUplinkDelivery(envelope(), { edgeId, receiverUrl }).send(), (error) => {
        assert.equal(error.code, 'UPLINK_LOCAL_ACK_INVALID');
        assert.equal(error.message.includes('untrusted-response-marker'), false);
        assert.equal(error.cause, undefined);
        return true;
      });
    });
  }
});

test('accepts contract-equivalent whitespace charset and escaped key spelling', async () => {
  await withReceiver((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(' { "dedu' + '\\u0070' + 'licated" : true } ');
  }, async (receiverUrl) => {
    assert.deepEqual(await prepareLocalUplinkDelivery(envelope(), { edgeId, receiverUrl }).send(),
      { acceptedLocally: true, deduplicated: true });
  });
});

test('rejects non-JSON and compressed acknowledgements', async () => {
  for (const headers of [
    { 'content-type': 'text/plain' },
    { 'content-type': 'application/json', 'content-encoding': 'gzip' }
  ]) {
    await withReceiver((req, res) => { res.writeHead(200, headers); res.end('{"deduplicated":false}'); },
      async (receiverUrl) => {
        await assert.rejects(prepareLocalUplinkDelivery(envelope(), { edgeId, receiverUrl }).send(),
          { code: 'UPLINK_LOCAL_ACK_INVALID' });
      });
  }
});

test('bounds streamed response bytes and sanitizes transport failures', async () => {
  await withReceiver((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(' '.repeat(3000));
    res.end(' '.repeat(3000));
  }, async (receiverUrl) => {
    await assert.rejects(prepareLocalUplinkDelivery(envelope(), { edgeId, receiverUrl }).send(),
      { code: 'UPLINK_LOCAL_ACK_INVALID' });
  });
});

test('enforces a total deadline on stalled acknowledgement bodies', async () => {
  await withReceiver((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"deduplicated":');
  }, async (receiverUrl) => {
    await assert.rejects(prepareLocalUplinkDelivery(envelope(), { edgeId, receiverUrl, timeoutMs: 100 }).send(),
      { code: 'UPLINK_LOCAL_TIMEOUT' });
  });
});

test('sanitizes refused connections without attached native cause', async () => {
  let receiverUrl;
  await withReceiver((req, res) => ack(res), async (url) => { receiverUrl = url; });
  await assert.rejects(prepareLocalUplinkDelivery(envelope(), { edgeId, receiverUrl }).send(), (error) => {
    assert.equal(error.code, 'UPLINK_LOCAL_TRANSPORT');
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes(receiverUrl), false);
    return true;
  });
});

test('does not echo unknown input field names or user-thrown validation exceptions', () => {
  for (const input of [
    { ...envelope(), 'untrusted-input-marker': true },
    { ...envelope(), get edge_id() {
      const error = new Error('untrusted-input-marker');
      error.code = 'UPLINK_INVALID_ENVELOPE';
      throw error;
    } }
  ]) {
    assert.throws(() => prepareLocalUplinkDelivery(input, { edgeId }), (error) => {
      assert.equal(error.code, 'UPLINK_INVALID_ENVELOPE');
      assert.equal(error.message.includes('untrusted-input-marker'), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('rejects invalid UTF-8 and interrupted acknowledgement bodies', async () => {
  await withReceiver((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.from([0xff]));
  }, async (receiverUrl) => {
    await assert.rejects(prepareLocalUplinkDelivery(envelope(), { edgeId, receiverUrl }).send(),
      { code: 'UPLINK_LOCAL_ACK_INVALID' });
  });
  await withReceiver((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
    res.write('{"deduplicated":');
    res.destroy();
  }, async (receiverUrl) => {
    await assert.rejects(prepareLocalUplinkDelivery(envelope(), { edgeId, receiverUrl }).send(),
      { code: 'UPLINK_LOCAL_TRANSPORT' });
  });
});

test('enforces deadline before response headers arrive', async () => {
  await withReceiver(() => {}, async (receiverUrl) => {
    await assert.rejects(prepareLocalUplinkDelivery(envelope(), { edgeId, receiverUrl, timeoutMs: 100 }).send(),
      { code: 'UPLINK_LOCAL_TIMEOUT' });
  });
});

test('includes adapter in the existing syntax gate', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.check, /node --check src\/uplink-local-client\.mjs/);
});

