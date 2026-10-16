import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createCapacityHttpServer } from '../src/capacity-http.mjs';
const token = 'synthetic-service-token-'.repeat(2);
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
