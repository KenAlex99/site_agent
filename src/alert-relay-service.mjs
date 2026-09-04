import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from './contracts.mjs';
import { normalizeAlertmanagerWebhook, normalizeAlertmanagerActiveAlerts } from './alertmanager-normalizer.mjs';

export class AlertRelayService {
  constructor({
    localToken, queue, worker, alertmanagerUrl, fetchImpl = globalThis.fetch,
    clock = () => Date.now(), logger = console, snapshotIntervalMs = 60_000,
    workerIntervalMs = 1_000, maxWebhookBytes = 1024 * 1024
  } = {}) {
    this.localToken = token(localToken);
    if (!queue || !worker || typeof fetchImpl !== 'function') throw new TypeError('queue, worker and fetchImpl are required');
    this.queue = queue;
    this.worker = worker;
    this.alertmanagerUrl = origin(alertmanagerUrl);
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.logger = logger;
    this.snapshotIntervalMs = snapshotIntervalMs;
    this.workerIntervalMs = workerIntervalMs;
    this.maxWebhookBytes = maxWebhookBytes;
    this.lastSnapshotSequence = 0;
    this.lastSnapshotSuccessAt = null;
    this.lastSnapshotErrorAt = null;
    this.closing = false;
    this.timers = [];
    this.inFlight = new Set();
  }

  handler() {
    return (req, res) => this.#handle(req, res).catch((error) => sendError(res, error));
  }

  start() {
    if (this.timers.length > 0 || this.closing) return;
    const drainTimer = setInterval(() => this.#background(() => this.worker.drainOnce()), this.workerIntervalMs);
    const snapshotTimer = setInterval(() => this.#background(() => this.pollSnapshot()), this.snapshotIntervalMs);
    drainTimer.unref?.();
    snapshotTimer.unref?.();
    this.timers.push(drainTimer, snapshotTimer);
    this.#background(() => this.worker.drainOnce());
    this.#background(() => this.pollSnapshot());
  }

  async stop() {
    this.closing = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await Promise.allSettled([...this.inFlight]);
  }

  async pollSnapshot() {
    if (this.closing) return { state: 'stopping' };
    try {
      const response = await this.fetchImpl(new URL('/api/v2/alerts', `${this.alertmanagerUrl}/`), {
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`Alertmanager returned HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 5 * 1024 * 1024) throw new Error('Alertmanager active alert response is too large');
      let active;
      try { active = JSON.parse(text); }
      catch { throw new Error('Alertmanager returned invalid JSON'); }
      const now = this.clock();
      const sequence = Math.max(this.lastSnapshotSequence + 1, now);
      const payload = normalizeAlertmanagerActiveAlerts(active, {
        observedAt: new Date(now).toISOString(), snapshotId: `ams-${sequence}`, sequence
      });
      const queued = await this.queue.enqueue(payload);
      this.lastSnapshotSequence = sequence;
      this.lastSnapshotSuccessAt = new Date(now).toISOString();
      this.#background(() => this.worker.drainOnce());
      return { state: 'queued', queueId: queued.queueId, sequence, alertCount: payload.alerts.length };
    } catch (error) {
      this.lastSnapshotErrorAt = new Date(this.clock()).toISOString();
      throw error;
    }
  }

  async #handle(req, res) {
    const url = new URL(req.url, 'http://relay.local');
    if (url.pathname === '/health') {
      if (req.method !== 'GET') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Only GET is supported');
      return sendJson(res, 200, {
        status: this.closing ? 'stopping' : 'up', queue: await this.queue.stats(),
        snapshots: { lastSequence: this.lastSnapshotSequence, lastSuccessAt: this.lastSnapshotSuccessAt, lastErrorAt: this.lastSnapshotErrorAt }
      });
    }
    if (url.pathname !== '/api/v1/alertmanager/webhook') throw new AppError(404, 'NOT_FOUND', 'Route was not found');
    if (this.closing) throw new AppError(503, 'ALERT_RELAY_STOPPING', 'Alert relay is stopping');
    if (req.method !== 'POST') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Only POST is supported');
    authenticate(req.headers.authorization, this.localToken);
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
      throw new AppError(415, 'ALERT_RELAY_JSON_REQUIRED', 'Content-Type must be application/json');
    }
    const input = await readJson(req, this.maxWebhookBytes);
    const observedAt = new Date(this.clock()).toISOString();
    const deliveryId = `amw-${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
    const payload = normalizeAlertmanagerWebhook(input, { observedAt, deliveryId });
    const queued = await this.queue.enqueue(payload);
    this.#background(() => this.worker.drainOnce());
    return sendJson(res, 202, { accepted: true, queueId: queued.queueId, deliveryId, alertCount: payload.alerts.length });
  }

  #background(operation) {
    if (this.closing) return;
    const promise = Promise.resolve().then(operation);
    this.inFlight.add(promise);
    promise.catch((error) => this.logger.warn?.({ code: 'ALERT_RELAY_BACKGROUND_ERROR', message: safeMessage(error) }))
      .finally(() => this.inFlight.delete(promise));
  }
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) tooLarge = true;
    else chunks.push(chunk);
  }
  if (tooLarge) throw new AppError(413, 'ALERT_RELAY_BODY_TOO_LARGE', 'Webhook body exceeds 1 MiB');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError(400, 'ALERT_RELAY_INVALID_JSON', 'Webhook body must be valid JSON'); }
}

function authenticate(header, expected) {
  const match = /^Bearer (.+)$/.exec(String(header || ''));
  const supplied = Buffer.from(match?.[1] || '');
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    throw new AppError(401, 'ALERT_RELAY_UNAUTHORIZED', 'A valid local Bearer credential is required');
  }
}

function token(value) {
  const normalized = String(value ?? '').trim();
  if (normalized.length < 16 || normalized.length > 4096 || /[\u0000-\u0020\u007f]/u.test(normalized)) throw new TypeError('localToken is invalid');
  return normalized;
}

function origin(value) {
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new TypeError('alertmanagerUrl must be an HTTP(S) origin');
  }
  return url.href.replace(/\/$/, '');
}

function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
}

function sendError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  sendJson(res, status, { code: error?.code || 'ALERT_RELAY_INTERNAL_ERROR', message: status >= 500 ? 'Alert relay request failed' : error.message });
}

function safeMessage(error) {
  if (error?.status) return `operation failed with HTTP ${error.status}`;
  return 'background operation failed';
}
