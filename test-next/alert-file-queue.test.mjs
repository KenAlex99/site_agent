import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomicAlertFileQueue } from '../src/alert-file-queue.mjs';

async function withQueue(options, run) {
  const rootDir = await mkdtemp(join(tmpdir(), 'alert-file-queue-'));
  try {
    const queue = new AtomicAlertFileQueue({ rootDir, clock: () => Date.parse('2026-09-04T09:00:00Z'), ...options });
    await queue.init();
    await run(queue, rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test('atomically enqueues into pending and discovers files after restart', () => withQueue({}, async (queue, rootDir) => {
  const added = await queue.enqueue({ kind: 'alert-events', deliveryId: 'delivery-01' });
  assert.match(added.queueId, /^\d{13}-\d{6}-[a-f0-9-]+$/);
  assert.deepEqual(await readdir(join(rootDir, 'tmp')), []);
  assert.equal((await readdir(join(rootDir, 'pending'))).length, 1);

  const restarted = new AtomicAlertFileQueue({ rootDir, clock: () => Date.parse('2026-09-04T09:01:00Z') });
  await restarted.init();
  const next = await restarted.peek();
  assert.equal(next.queueId, added.queueId);
  assert.equal(next.payload.deliveryId, 'delivery-01');
  assert.equal((await restarted.stats()).oldestAgeMs, 60_000);
}));

test('returns oldest entries in filename order and acknowledges only the selected item', () => withQueue({}, async (queue) => {
  const first = await queue.enqueue({ deliveryId: 'first' });
  const second = await queue.enqueue({ deliveryId: 'second' });
  assert.equal((await queue.peek()).payload.deliveryId, 'first');
  await queue.ack(first.queueId);
  assert.equal((await queue.peek()).queueId, second.queueId);
  assert.equal((await queue.stats()).entries, 1);
}));

test('persists retry metadata and moves permanent failures to dead letter storage', () => withQueue({}, async (queue, rootDir) => {
  const added = await queue.enqueue({ deliveryId: 'retry-me' });
  await queue.retry(added.queueId, { error: 'cloud temporarily unavailable', nextAttemptAt: '2026-09-04T09:00:10Z' });
  const retried = await queue.peek();
  assert.equal(retried.attempts, 1);
  assert.equal(retried.lastError, 'cloud temporarily unavailable');
  assert.equal(retried.nextAttemptAt, '2026-09-04T09:00:10.000Z');

  await queue.deadLetter(added.queueId, { reason: 'cloud rejected schema' });
  assert.equal(await queue.peek(), null);
  assert.deepEqual(await readdir(join(rootDir, 'pending')), []);
  const deadFiles = await readdir(join(rootDir, 'dead'));
  assert.equal(deadFiles.length, 1);
  const dead = JSON.parse(await readFile(join(rootDir, 'dead', deadFiles[0]), 'utf8'));
  assert.equal(dead.deadLetterReason, 'cloud rejected schema');
  assert.equal(dead.payload.deliveryId, 'retry-me');
}));

test('rejects entry-count and byte-capacity overflow without leaving temporary files', () => withQueue({ maxEntries: 1 }, async (queue, rootDir) => {
  await queue.enqueue({ deliveryId: 'fits' });
  await assert.rejects(() => queue.enqueue({ deliveryId: 'too-many' }), /capacity/i);
  assert.deepEqual(await readdir(join(rootDir, 'tmp')), []);
  assert.equal((await queue.stats()).entries, 1);
}));

test('rejects a single record larger than the configured byte capacity', () => withQueue({ maxBytes: 200 }, async (queue, rootDir) => {
  await assert.rejects(() => queue.enqueue({ payload: 'x'.repeat(500) }), /capacity/i);
  assert.deepEqual(await readdir(join(rootDir, 'tmp')), []);
  assert.equal((await queue.stats()).bytes, 0);
}));
