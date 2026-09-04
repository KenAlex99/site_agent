import { AlertCloudDeliveryError } from './alert-cloud-client.mjs';

export class AlertQueueWorker {
  constructor({
    queue, client, clock = () => Date.now(), random = Math.random,
    baseDelayMs = 1_000, maxDelayMs = 60_000
  } = {}) {
    if (!queue || !client) throw new TypeError('queue and client are required');
    this.queue = queue;
    this.client = client;
    this.clock = clock;
    this.random = random;
    this.baseDelayMs = positiveInteger(baseDelayMs, 'baseDelayMs');
    this.maxDelayMs = positiveInteger(maxDelayMs, 'maxDelayMs');
    this.active = null;
  }

  drainOnce() {
    if (this.active) return this.active;
    this.active = this.#drain().finally(() => { this.active = null; });
    return this.active;
  }

  async #drain() {
    const record = await this.queue.peek();
    if (!record) return { state: 'idle' };
    const now = this.clock();
    if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > now) {
      return { state: 'waiting', queueId: record.queueId, nextAttemptAt: record.nextAttemptAt };
    }
    try {
      await this.client.upload(record.payload);
      await this.queue.ack(record.queueId);
      return { state: 'delivered', queueId: record.queueId };
    } catch (error) {
      const failure = classify(error);
      if (!failure.retryable) {
        await this.queue.deadLetter(record.queueId, { reason: failure.description });
        return { state: 'dead-letter', queueId: record.queueId, status: failure.status };
      }
      const delay = this.#backoff(record.attempts || 0);
      const nextAttemptAt = new Date(now + delay).toISOString();
      await this.queue.retry(record.queueId, { error: failure.description, nextAttemptAt });
      return { state: 'retry', queueId: record.queueId, nextAttemptAt, status: failure.status };
    }
  }

  #backoff(attempts) {
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** Math.min(attempts, 30)));
    const jittered = exponential * (0.5 + Math.min(Math.max(Number(this.random()) || 0, 0), 1));
    return Math.max(1, Math.min(this.maxDelayMs, Math.round(jittered)));
  }
}

function classify(error) {
  if (error instanceof AlertCloudDeliveryError) {
    return {
      retryable: error.retryable,
      status: error.status,
      description: error.status
        ? `cloud alert delivery failed with HTTP ${error.status}`
        : `cloud alert delivery failed (${error.code})`
    };
  }
  return { retryable: true, status: null, description: 'cloud alert delivery failed (unexpected error)' };
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
  return value;
}
