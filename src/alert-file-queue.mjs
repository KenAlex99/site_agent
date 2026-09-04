import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { AppError } from './contracts.mjs';

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export class AtomicAlertFileQueue {
  constructor({ rootDir, maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES, clock = () => Date.now() } = {}) {
    if (!rootDir) throw new TypeError('rootDir is required');
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');
    this.rootDir = resolve(rootDir);
    this.tmpDir = join(this.rootDir, 'tmp');
    this.pendingDir = join(this.rootDir, 'pending');
    this.deadDir = join(this.rootDir, 'dead');
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.clock = clock;
    this.sequence = 0;
    this.writeChain = Promise.resolve();
    this.initialized = false;
  }

  async init() {
    await Promise.all([
      mkdir(this.tmpDir, { recursive: true, mode: 0o700 }),
      mkdir(this.pendingDir, { recursive: true, mode: 0o700 }),
      mkdir(this.deadDir, { recursive: true, mode: 0o700 })
    ]);
    const abandoned = await readdir(this.tmpDir, { withFileTypes: true });
    await Promise.all(abandoned.filter((entry) => entry.isFile()).map((entry) => unlink(join(this.tmpDir, entry.name))));
    this.initialized = true;
    return this.stats();
  }

  enqueue(payload) {
    return this.#serialized(async () => {
      this.#requireInit();
      if (!plainObject(payload)) throw new TypeError('queue payload must be a JSON object');
      const now = this.clock();
      const suffix = randomUUID();
      const queueId = `${String(now).padStart(13, '0')}-${String(this.sequence++).padStart(6, '0')}-${suffix}`;
      const record = {
        version: 1, queueId, createdAt: new Date(now).toISOString(),
        attempts: 0, nextAttemptAt: null, lastError: null, payload
      };
      const bytes = serialize(record);
      const current = await this.#stats();
      if (current.entries >= this.maxEntries || current.bytes + bytes.byteLength > this.maxBytes) {
        throw new AppError(507, 'ALERT_QUEUE_CAPACITY_EXCEEDED', 'Alert queue capacity has been reached');
      }
      await this.#atomicWrite(this.pendingDir, queueId, bytes);
      return clone(record);
    });
  }

  async peek() {
    this.#requireInit();
    await this.writeChain;
    const files = await this.#pendingFiles();
    if (files.length === 0) return null;
    return this.#readRecord(files[0]);
  }

  ack(queueId) {
    return this.#serialized(async () => {
      this.#requireInit();
      await unlink(this.#recordPath(this.pendingDir, queueId));
      await syncDirectory(this.pendingDir);
    });
  }

  retry(queueId, { error, nextAttemptAt } = {}) {
    return this.#serialized(async () => {
      this.#requireInit();
      const path = this.#recordPath(this.pendingDir, queueId);
      const record = await this.#readRecord(`${queueId}.json`);
      record.attempts += 1;
      record.lastError = boundedText(error, 'retry error', 500);
      record.nextAttemptAt = timestamp(nextAttemptAt, 'nextAttemptAt');
      await this.#atomicWrite(this.pendingDir, queueId, serialize(record), { replacePath: path });
      return clone(record);
    });
  }

  deadLetter(queueId, { reason } = {}) {
    return this.#serialized(async () => {
      this.#requireInit();
      const pendingPath = this.#recordPath(this.pendingDir, queueId);
      const record = await this.#readRecord(`${queueId}.json`);
      record.deadLetterAt = new Date(this.clock()).toISOString();
      record.deadLetterReason = boundedText(reason, 'dead letter reason', 500);
      await this.#atomicWrite(this.pendingDir, queueId, serialize(record), { replacePath: pendingPath });
      await rename(pendingPath, this.#recordPath(this.deadDir, queueId));
      await Promise.all([syncDirectory(this.pendingDir), syncDirectory(this.deadDir)]);
      return clone(record);
    });
  }

  async stats() {
    this.#requireInit();
    await this.writeChain;
    return this.#stats();
  }

  async #stats() {
    const files = await this.#pendingFiles();
    let bytes = 0;
    for (const file of files) bytes += (await stat(join(this.pendingDir, file))).size;
    let oldestAgeMs = null;
    if (files.length > 0) {
      const oldest = await this.#readRecord(files[0]);
      oldestAgeMs = Math.max(0, this.clock() - Date.parse(oldest.createdAt));
    }
    return { entries: files.length, bytes, oldestAgeMs, maxEntries: this.maxEntries, maxBytes: this.maxBytes };
  }

  async #pendingFiles() {
    return (await readdir(this.pendingDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  }

  async #readRecord(fileName) {
    const record = JSON.parse(await readFile(join(this.pendingDir, fileName), 'utf8'));
    if (!plainObject(record) || record.version !== 1 || `${record.queueId}.json` !== fileName) {
      throw new AppError(500, 'ALERT_QUEUE_CORRUPT_RECORD', 'Alert queue contains an invalid record');
    }
    return record;
  }

  async #atomicWrite(targetDir, queueId, bytes, { replacePath } = {}) {
    const targetPath = replacePath || this.#recordPath(targetDir, queueId);
    const tmpPath = join(this.tmpDir, `${queueId}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(tmpPath, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tmpPath, targetPath);
      await syncDirectory(targetDir);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  #recordPath(directory, queueId) {
    if (!/^\d{13}-\d{6}-[a-f0-9-]{36}$/.test(String(queueId))) {
      throw new AppError(400, 'ALERT_QUEUE_INVALID_ID', 'Alert queue ID is invalid');
    }
    return join(directory, `${queueId}.json`);
  }

  #serialized(operation) {
    const result = this.writeChain.then(operation);
    this.writeChain = result.catch(() => {});
    return result;
  }

  #requireInit() {
    if (!this.initialized) throw new Error('Alert queue is not initialized');
  }
}

function serialize(value) {
  let json;
  try { json = JSON.stringify(value); }
  catch { throw new TypeError('queue payload must be JSON serializable'); }
  if (json === undefined) throw new TypeError('queue payload must be JSON serializable');
  return Buffer.from(`${json}\n`, 'utf8');
}

function boundedText(value, field, max) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new TypeError(`${field} is invalid`);
  return normalized;
}

function timestamp(value, field) {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} is invalid`);
  return new Date(parsed).toISOString();
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    if (handle) await handle.close();
  }
}
