import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertCloudClient, AlertCloudDeliveryError } from '../src/alert-cloud-client.mjs';
import { AlertQueueWorker } from '../src/alert-queue-worker.mjs';

const token = 'relay-test-token-that-must-not-leak';

test('uploads event and snapshot payloads to authenticated cloud endpoints', async () => {
  const calls = [];
  const client = new AlertCloudClient({
    baseUrl: 'https://cloud.example', token,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
  });
  await client.upload({ kind: 'alert-events', deliveryId: 'delivery-01' });
  await client.upload({ kind: 'alert-snapshot', snapshotId: 'snapshot-01' });
  assert.deepEqual(calls.map((call) => call.url), [
    'https://cloud.example/api/v1/site-agent/alert-events',
    'https://cloud.example/api/v1/site-agent/alert-snapshots'
  ]);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`);
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
});

test('validates cloud URLs and never permits embedded credentials or query data', () => {
  for (const baseUrl of ['ftp://cloud.example', 'https://user:pass@cloud.example', 'https://cloud.example?a=1', 'https://cloud.example/#x']) {
    assert.throws(() => new AlertCloudClient({ baseUrl, token }), /URL/i);
  }
});

test('classifies timeout, throttling and server errors as retryable without leaking credentials', async () => {
  const timeoutClient = new AlertCloudClient({
    baseUrl: 'https://cloud.example', token, timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  });
  await assert.rejects(
    () => timeoutClient.upload({ kind: 'alert-events' }),
    (error) => error instanceof AlertCloudDeliveryError && error.retryable && !error.message.includes(token)
  );

  for (const status of [429, 500, 503]) {
    const client = new AlertCloudClient({ baseUrl: 'https://cloud.example', token, fetchImpl: async () => new Response('private upstream body', { status }) });
    await assert.rejects(() => client.upload({ kind: 'alert-events' }), (error) => error.retryable && error.status === status && !error.message.includes('private'));
  }
});

test('classifies invalid cloud requests as permanent dead-letter candidates', async () => {
  const client = new AlertCloudClient({ baseUrl: 'https://cloud.example', token, fetchImpl: async () => new Response('details', { status: 400 }) });
  await assert.rejects(
    () => client.upload({ kind: 'alert-events' }),
    (error) => error instanceof AlertCloudDeliveryError && error.retryable === false && error.status === 400
  );
});

test('drains one record with single-flight protection and acknowledges cloud success', async () => {
  let release;
  let uploads = 0;
  const calls = { ack: [], retry: [], dead: [] };
  const record = { queueId: 'q1', attempts: 0, nextAttemptAt: null, payload: { kind: 'alert-events' } };
  const queue = {
    async peek() { return record; },
    async ack(id) { calls.ack.push(id); },
    async retry(id, options) { calls.retry.push({ id, options }); },
    async deadLetter(id, options) { calls.dead.push({ id, options }); }
  };
  const client = { async upload() { uploads += 1; await new Promise((done) => { release = done; }); } };
  const worker = new AlertQueueWorker({ queue, client, clock: () => Date.parse('2026-09-04T10:00:00Z'), random: () => 0.5 });
  const first = worker.drainOnce();
  const second = worker.drainOnce();
  assert.equal(first, second);
  await new Promise((done) => setImmediate(done));
  release();
  assert.deepEqual(await first, { state: 'delivered', queueId: 'q1' });
  assert.equal(uploads, 1);
  assert.deepEqual(calls.ack, ['q1']);
});

test('retries transient errors with bounded backoff and dead-letters permanent errors', async () => {
  const actions = [];
  const transientQueue = queueFor({ queueId: 'q2', attempts: 2, nextAttemptAt: null, payload: { kind: 'alert-events' } }, actions);
  const transientWorker = new AlertQueueWorker({
    queue: transientQueue,
    client: { async upload() { throw new AlertCloudDeliveryError('temporary', { status: 503, retryable: true }); } },
    clock: () => Date.parse('2026-09-04T10:00:00Z'), random: () => 0.5, baseDelayMs: 1000, maxDelayMs: 60_000
  });
  assert.equal((await transientWorker.drainOnce()).state, 'retry');
  assert.equal(actions[0].type, 'retry');
  assert.equal(actions[0].options.nextAttemptAt, '2026-09-04T10:00:04.000Z');

  actions.length = 0;
  const permanentQueue = queueFor({ queueId: 'q3', attempts: 0, nextAttemptAt: null, payload: { kind: 'alert-snapshot' } }, actions);
  const permanentWorker = new AlertQueueWorker({
    queue: permanentQueue,
    client: { async upload() { throw new AlertCloudDeliveryError('bad request', { status: 400, retryable: false }); } }
  });
  assert.equal((await permanentWorker.drainOnce()).state, 'dead-letter');
  assert.equal(actions[0].type, 'dead');
});

function queueFor(record, actions) {
  return {
    async peek() { return record; },
    async ack(id) { actions.push({ type: 'ack', id }); },
    async retry(id, options) { actions.push({ type: 'retry', id, options }); },
    async deadLetter(id, options) { actions.push({ type: 'dead', id, options }); }
  };
}
