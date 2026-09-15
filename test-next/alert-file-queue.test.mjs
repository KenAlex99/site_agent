import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
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
  assert.match(added.queueId, /^\d{13}-\d{16}-[a-f0-9-]+$/);
  assert.deepEqual(await readdir(join(rootDir, 'tmp')), []);
  assert.equal((await readdir(join(rootDir, 'pending'))).length, 1);

  const restarted = new AtomicAlertFileQueue({ rootDir, clock: () => Date.parse('2026-09-04T09:01:00Z') });
  await restarted.init();
  const next = await restarted.peek();
  assert.equal(next.queueId, added.queueId);
  assert.equal(next.payload.deliveryId, 'delivery-01');
  assert.equal((await restarted.stats()).oldestAgeMs, 60_000);
}));

test('keeps queue identifiers valid and ordered after one million enqueues', () => withQueue({}, async (queue) => {
  queue.sequence = 1_000_000;
  const millionth = await queue.enqueue({ deliveryId: 'millionth' });
  const next = await queue.enqueue({ deliveryId: 'next' });

  assert.match(millionth.queueId, /^\d{13}-0000000001000000-[a-f0-9-]+$/);
  assert.match(next.queueId, /^\d{13}-0000000001000001-[a-f0-9-]+$/);
  assert.equal((await queue.peek()).queueId, millionth.queueId);
}));

test('continues to read legacy six-digit queue identifiers after upgrade', () => withQueue({}, async (queue, rootDir) => {
  const queueId = '1788512400000-000007-11111111-1111-4111-8111-111111111111';
  await writeFile(join(rootDir, 'pending', `${queueId}.json`), JSON.stringify({
    version: 1, queueId, createdAt: '2026-09-04T09:00:00.000Z',
    attempts: 0, nextAttemptAt: null, lastError: null, payload: { deliveryId: 'legacy' }
  }));

  assert.equal((await queue.peek()).payload.deliveryId, 'legacy');
}));

test('quarantines a corrupt head record and continues with the next delivery', () => withQueue({}, async (queue, rootDir) => {
  const first = await queue.enqueue({ deliveryId: 'first' });
  const second = await queue.enqueue({ deliveryId: 'second' });
  await writeFile(join(rootDir, 'pending', `${first.queueId}.json`), '{broken-json', 'utf8');

  assert.equal((await queue.peek()).queueId, second.queueId);
  assert.deepEqual(await readdir(join(rootDir, 'pending')), [`${second.queueId}.json`]);
  const firstQuarantine = await readdir(join(rootDir, 'corrupt'));
  assert.equal(firstQuarantine.length, 1);
  assert.equal(await readFile(join(rootDir, 'corrupt', firstQuarantine[0]), 'utf8'), '{broken-json');
  assert.equal((await queue.stats()).entries, 1);

  await writeFile(join(rootDir, 'pending', '000.json'), JSON.stringify({
    version: 1, queueId: '000', createdAt: '2026-09-04T09:00:00.000Z', payload: { deliveryId: 'untrusted-name' }
  }));
  assert.equal((await queue.peek()).queueId, second.queueId);
  assert.equal((await readdir(join(rootDir, 'corrupt'))).length, 2);
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

test('rejects a filesystem root as queue root', () => {
  assert.throws(() => new AtomicAlertFileQueue({ rootDir: parse(tmpdir()).root }), /root/i);
});

test('startup cleanup preserves unrelated files in the queue tmp directory', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'alert-file-queue-cleanup-'));
  try {
    const queueTmp = join(rootDir, 'tmp');
    await mkdir(queueTmp);
    await writeFile(join(queueTmp, 'operator-note.txt'), 'do not remove');
    const abandonedQueueFile = '1760000000000-000001-11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222.tmp';
    await writeFile(join(queueTmp, abandonedQueueFile), 'partial queue record');

    const queue = new AtomicAlertFileQueue({ rootDir });
    await queue.init();

    assert.deepEqual(await readdir(queueTmp), ['operator-note.txt']);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
