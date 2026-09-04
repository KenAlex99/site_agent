import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestId } from '../public-next/request-id.js';

test('uses crypto.randomUUID when the browser provides it', () => {
  const id = createRequestId({ cryptoApi: { randomUUID: () => 'native-request-id' } });
  assert.equal(id, 'native-request-id');
});

test('creates an RFC 4122 v4 identifier when randomUUID is unavailable on LAN HTTP', () => {
  const cryptoApi = {
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
      return bytes;
    }
  };
  const id = createRequestId({ cryptoApi });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('still returns distinct valid correlation IDs without a Web Crypto object', () => {
  const options = { cryptoApi: null, now: () => 1_788_400_000_000, random: () => 0.25 };
  const first = createRequestId(options);
  const second = createRequestId(options);
  assert.notEqual(first, second);
  assert.match(first, /^[a-zA-Z0-9_.:-]{1,128}$/);
  assert.match(second, /^[a-zA-Z0-9_.:-]{1,128}$/);
});
