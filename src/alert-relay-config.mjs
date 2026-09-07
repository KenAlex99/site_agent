import { resolve } from 'node:path';

export function loadAlertRelayConfig(env = process.env) {
  if (env.ALERT_CLOUD_TOKEN || env.ALERT_RELAY_TOKEN) {
    throw new Error('Use ALERT_CLOUD_TOKEN_FILE and ALERT_RELAY_TOKEN_FILE; inline token variables are not accepted');
  }
  return {
    host: host(env.ALERT_RELAY_HOST || '127.0.0.1'),
    port: integer(env.ALERT_RELAY_PORT || 4312, 'ALERT_RELAY_PORT', 1, 65535),
    queueDir: resolve(required(env.ALERT_QUEUE_DIR, 'ALERT_QUEUE_DIR')),
    localTokenFile: resolve(required(env.ALERT_RELAY_TOKEN_FILE, 'ALERT_RELAY_TOKEN_FILE')),
    cloudTokenFile: resolve(required(env.ALERT_CLOUD_TOKEN_FILE, 'ALERT_CLOUD_TOKEN_FILE')),
    cloudUrl: origin(env.ALERT_CLOUD_URL, 'ALERT_CLOUD_URL', { requireHttpsForRemote: true }),
    alertmanagerUrl: origin(env.ALERTMANAGER_URL || 'http://alertmanager:9093', 'ALERTMANAGER_URL'),
    snapshotIntervalMs: integer(env.ALERT_SNAPSHOT_INTERVAL_MS || 60_000, 'ALERT_SNAPSHOT_INTERVAL_MS', 100, 3_600_000),
    workerIntervalMs: integer(env.ALERT_WORKER_INTERVAL_MS || 1_000, 'ALERT_WORKER_INTERVAL_MS', 50, 60_000),
    cloudTimeoutMs: integer(env.ALERT_CLOUD_TIMEOUT_MS || 10_000, 'ALERT_CLOUD_TIMEOUT_MS', 100, 120_000),
    maxEntries: integer(env.ALERT_QUEUE_MAX_ENTRIES || 10_000, 'ALERT_QUEUE_MAX_ENTRIES', 1, 1_000_000),
    maxBytes: integer(env.ALERT_QUEUE_MAX_BYTES || 256 * 1024 * 1024, 'ALERT_QUEUE_MAX_BYTES', 1024, Number.MAX_SAFE_INTEGER)
  };
}

function origin(value, field, { requireHttpsForRemote = false } = {}) {
  let url;
  try { url = new URL(required(value, field)); }
  catch { throw new Error(`${field} must be a valid URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error(`${field} must be an HTTP(S) origin without credentials, path, query or fragment`);
  }
  if (requireHttpsForRemote && url.protocol === 'http:' && !loopbackHost(url.hostname)) {
    throw new Error(`${field} must use HTTPS unless it targets the local loopback interface`);
  }
  return url.href.replace(/\/$/, '');
}

function loopbackHost(hostname) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname.toLowerCase());
}

function required(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function integer(value, field, min, max) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) throw new Error(`${field} is invalid`);
  return normalized;
}

function host(value) {
  const normalized = String(value).trim();
  if (!/^(?:127\.0\.0\.1|0\.0\.0\.0|::1|::)$/.test(normalized)) throw new Error('ALERT_RELAY_HOST must be a local or wildcard bind address');
  return normalized;
}
