import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createCapacityHttpServer } from '../src/capacity-http.mjs';
const token = 'synthetic-service-token-'.repeat(2);

async function boundedFixture(provider, options = {}) {
  const server = createCapacityHttpServer({ token, deviceIds: ['1'], provider, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, url: 'http://127.0.0.1:' + server.address().port, close() { server.closeAllConnections(); server.close(); } };
}
const authorized = { authorization: 'Bearer ' + token };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('deadline configuration is server-owned and cannot exceed ten seconds', () => {
  for (const timeoutMs of [0, -1, 10001, 1.5, NaN, Infinity, '30', null]) {
    assert.throws(() => createCapacityHttpServer({ token, deviceIds: ['1'], provider: { getDeviceCapacityPage() {} }, timeoutMs }));
  }
});

test('HTTP returns a hard 504 when the provider ignores cancellation forever', { timeout: 3000 }, async () => {
  let signal;
  const f = await boundedFixture({ getDeviceCapacityPage: (id, type, options) => { signal = options.signal; return new Promise(() => {}); } }, { timeoutMs: 30 });
  try {
    const response = await fetch(f.url + path, { headers: authorized, signal: AbortSignal.timeout(800) });
    assert.equal(response.status, 504); assert.deepEqual(await response.json(), { code: 'CAPACITY_TIMEOUT' });
    assert.equal(signal.aborted, true);
  } finally { f.close(); }
});

for (const outcome of ['resolve', 'reject']) test('late provider ' + outcome + ' cannot replace timeout or poison the next request', { timeout: 3000 }, async () => {
  let settle, calls = 0;
  const f = await boundedFixture({ getDeviceCapacityPage() {
    if (++calls === 1) return new Promise((resolve, reject) => { settle = outcome === 'resolve' ? () => resolve({ PRIVATE: true }) : () => reject(new Error('PRIVATE')); });
    return { recovered: true };
  } }, { timeoutMs: 30 });
  try {
    const response = await fetch(f.url + path, { headers: authorized, signal: AbortSignal.timeout(800) });
    assert.equal(response.status, 504); assert.deepEqual(await response.json(), { code: 'CAPACITY_TIMEOUT' });
    settle(); await pause(10);
    const next = await fetch(f.url + path, { headers: authorized, signal: AbortSignal.timeout(800) });
    assert.equal(next.status, 200); assert.deepEqual(await next.json(), { recovered: true }); assert.equal(calls, 2);
  } finally { f.close(); }
});

test('real HTTP disconnect cancels an ignored provider and a later request still works', { timeout: 3000 }, async () => {
  const { request } = await import('node:http');
  let markStarted, markCancelled, calls = 0;
  const started = new Promise(resolve => { markStarted = resolve; });
  const cancelled = new Promise(resolve => { markCancelled = resolve; });
  const f = await boundedFixture({ getDeviceCapacityPage(id, type, options) {
    if (++calls > 1) return { recovered: true };
    options.signal.addEventListener('abort', markCancelled, { once: true }); markStarted();
    return new Promise(() => {});
  } }, { timeoutMs: 500 });
  const req = request(f.url + path, { headers: authorized }); req.on('error', () => {});
  try {
    req.end(); await started; req.destroy();
    await Promise.race([cancelled, pause(800).then(() => { throw new Error('disconnect_not_cancelled'); })]);
    const response = await fetch(f.url + path, { headers: authorized, signal: AbortSignal.timeout(800) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { recovered: true });
  } finally { req.destroy(); f.close(); }
});

test('successful HTTP requests remove their deadline without aborting completed work', async () => {
  let signal;
  const f = await boundedFixture({ getDeviceCapacityPage(id, type, options) { signal = options.signal; return { ok: true }; } }, { timeoutMs: 30 });
  try {
    const response = await fetch(f.url + path, { headers: authorized }); assert.equal(response.status, 200); await response.json();
    await pause(70); assert.equal(signal.aborted, false);
  } finally { f.close(); }
});

test('oversized provider output remains a sanitized bounded error', async () => {
  const f = await boundedFixture({ getDeviceCapacityPage: () => ({ PRIVATE: 'x'.repeat(262144) }) }, { timeoutMs: 30 });
  try {
    const response = await fetch(f.url + path, { headers: authorized }); assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { code: 'CAPACITY_RESPONSE_LIMIT' });
  } finally { f.close(); }
});
async function fixture() {
  const calls = [];
  const server = createCapacityHttpServer({ token, deviceIds: ['1'], provider: { getDeviceCapacityPage: async (id, type, options) => { calls.push({ id, type, options }); return { device_id: id, resource_type: type }; } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { calls, server, url: 'http://127.0.0.1:' + server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
}
const path = '/api/v1/monitoring/devices/1/capacity/mempool';
test('missing configuration cannot create an anonymous capacity service', () => {
  for (const options of [{}, { token: '', deviceIds: ['1'], provider: {} }, { token, deviceIds: [], provider: {} }]) assert.throws(() => createCapacityHttpServer(options));
});
test('capacity requires service identity before provider I/O and ignores spoofed scope', async () => {
  const f = await fixture();
  try { for (const authorization of ['', 'Bearer WRONG']) { const r = await fetch(f.url + path, { headers: { authorization, 'x-platform-permissions': '*' } }); assert.equal(r.status, 401); } assert.equal(f.calls.length, 0); } finally { f.close(); }
});
test('only explicit fixed GET/page parameters reach the reader', async () => {
  const f = await fixture();
  try { const r = await fetch(f.url + path + '?page=2&pageSize=10', { headers: { authorization: 'Bearer ' + token } }); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(f.calls[0].id, '1'); assert.equal(f.calls[0].options.page, 2); assert.ok(f.calls[0].options.signal instanceof AbortSignal); } finally { f.close(); }
});
test('rejects writes, other devices, unsafe IDs, aliases and unsupported resource types', async () => {
  const f = await fixture(), headers = { authorization: 'Bearer ' + token };
  try {
    assert.equal((await fetch(f.url + path, { method: 'POST', headers })).status, 405);
    for (const p of [path.replace('/1/', '/2/'), path.replace('/1/', '/9007199254740993/'), path.replace('/1/', '/%31/'), path.replace('mempool', 'voltage'), '/internal/capacity']) assert.equal((await fetch(f.url + p, { headers })).status, 404);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test('rejects duplicate/unknown/zero/oversize query parameters', async () => {
  const f = await fixture(), headers = { authorization: 'Bearer ' + token };
  try { for (const q of ['?page=1&page=2', '?token=x', '?page=0', '?pageSize=21', '?page=100001', '?pageSize=01']) assert.equal((await fetch(f.url + path + q, { headers })).status, 400); assert.equal(f.calls.length, 0); } finally { f.close(); }
});
test('provider failures are sanitized and never log source messages', async () => {
  const server = createCapacityHttpServer({ token, deviceIds: ['1'], provider: { getDeviceCapacityPage: async () => { throw Object.assign(new Error('PRIVATE'), { status: 500 }); } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { const r = await fetch('http://127.0.0.1:' + server.address().port + path, { headers: { authorization: 'Bearer ' + token } }); assert.equal(r.status, 502); assert.doesNotMatch(await r.text(), /PRIVATE/); } finally { server.closeAllConnections(); server.close(); }
});
