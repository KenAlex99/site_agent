import { AppError } from './contracts.mjs';

const identityFields = ['tenantId', 'siteId', 'sourceId'];
const eventKeys = new Set(['schemaVersion', 'deliveryId', 'kind', 'observedAt', 'tenantId', 'siteId', 'sourceId', 'status', 'groupKey', 'receiver', 'alerts']);
const snapshotKeys = new Set(['schemaVersion', 'snapshotId', 'sequence', 'kind', 'observedAt', 'tenantId', 'siteId', 'sourceId', 'alerts']);
const alertKeys = new Set(['fingerprint', 'status', 'startsAt', 'endsAt', 'labels', 'annotations']);
const alertStates = new Set(['firing', 'resolved', 'suppressed']);
const deliveryStates = new Set(['firing', 'resolved']);
const sensitiveKey = /(authorization|community|credential|password|secret|token)/i;

export function normalizeAlertEventBatch(input, identity, { now = Date.now() } = {}) {
  envelope(input, eventKeys, identity, now);
  if (input.kind !== 'alert-events') invalid('kind must be alert-events');
  const alerts = alertArray(input.alerts, 100);
  return omitUndefined({
    schemaVersion: '1.0', deliveryId: identifier(input.deliveryId, 'deliveryId'),
    kind: 'alert-events', observedAt: timestamp(input.observedAt, 'observedAt'),
    status: enumValue(input.status, deliveryStates, 'status'),
    groupKey: optionalText(input.groupKey, 'groupKey', 512),
    receiver: optionalText(input.receiver, 'receiver', 160), alerts
  });
}

export function normalizeAlertSnapshotBatch(input, identity, { now = Date.now() } = {}) {
  envelope(input, snapshotKeys, identity, now);
  if (input.kind !== 'alert-snapshot') invalid('kind must be alert-snapshot');
  return {
    schemaVersion: '1.0', snapshotId: identifier(input.snapshotId, 'snapshotId'),
    sequence: integer(input.sequence, 'sequence', 1, Number.MAX_SAFE_INTEGER),
    kind: 'alert-snapshot', observedAt: timestamp(input.observedAt, 'observedAt'),
    alerts: alertArray(input.alerts, 5000)
  };
}

function envelope(input, allowed, identity, now) {
  if (!plainObject(input)) invalid('batch must be a JSON object');
  allowedKeys(input, allowed, 'batch');
  for (const field of identityFields) {
    if (input[field] !== undefined && input[field] !== identity[field]) {
      throw new AppError(403, 'SITE_AGENT_IDENTITY_MISMATCH', `${field} does not match the authenticated source`);
    }
  }
  if (input.schemaVersion !== '1.0') invalid('schemaVersion must be 1.0');
  const observed = timestamp(input.observedAt, 'observedAt');
  if (Date.parse(observed) > now + 5 * 60_000) invalid('observedAt is too far in the future');
}

function alertArray(value, max) {
  if (!Array.isArray(value) || value.length > max) invalid(`alerts must be an array with at most ${max} items`);
  const alerts = value.map(normalizeAlert);
  if (new Set(alerts.map((item) => item.fingerprint)).size !== alerts.length) invalid('alerts contains duplicate fingerprint');
  return alerts;
}

function normalizeAlert(input, index) {
  const path = `alerts[${index}]`;
  if (!plainObject(input)) invalid(`${path} must be an object`);
  allowedKeys(input, alertKeys, path);
  const labels = stringMap(input.labels, `${path}.labels`, 64, 512);
  if (!labels.alertname) invalid(`${path}.labels.alertname is required`);
  return omitUndefined({
    fingerprint: identifier(input.fingerprint, `${path}.fingerprint`),
    status: enumValue(input.status, alertStates, `${path}.status`),
    startsAt: timestamp(input.startsAt, `${path}.startsAt`),
    endsAt: optionalTimestamp(input.endsAt, `${path}.endsAt`),
    labels,
    annotations: stringMap(input.annotations ?? {}, `${path}.annotations`, 32, 2000, true)
  });
}

function stringMap(value, path, maxEntries, maxValue, allowEmpty = false) {
  if (!plainObject(value)) invalid(`${path} must be an object`);
  const entries = Object.entries(value);
  if ((!allowEmpty && entries.length === 0) || entries.length > maxEntries) invalid(`${path} has an invalid number of entries`);
  const result = {};
  for (const [key, value] of entries) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/.test(key) || sensitiveKey.test(key)) invalid(`${path}.${key} is not allowed`);
    result[key] = text(value, `${path}.${key}`, maxValue);
  }
  return result;
}

function allowedKeys(value, allowed, path) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) invalid(`${path}.${unknown} is not allowed`);
}

function identifier(value, field) {
  const normalized = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,159}$/.test(normalized) || normalized.includes('..')) invalid(`${field} is invalid`);
  return normalized;
}

function text(value, field, max) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) invalid(`${field} is invalid`);
  return normalized;
}

function optionalText(value, field, max) {
  return value === undefined || value === null || value === '' ? undefined : text(value, field, max);
}

function enumValue(value, allowed, field) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!allowed.has(normalized)) invalid(`${field} is invalid`);
  return normalized;
}

function timestamp(value, field) {
  const normalized = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) invalid(`${field} must be an ISO 8601 timestamp with timezone`);
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) invalid(`${field} is invalid`);
  return new Date(epoch).toISOString();
}

function optionalTimestamp(value, field) {
  return value === undefined || value === null || value === '' ? undefined : timestamp(value, field);
}

function integer(value, field, min, max) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) invalid(`${field} is invalid`);
  return normalized;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function invalid(message) {
  throw new AppError(400, 'SITE_AGENT_INVALID_ALERT_BATCH', message);
}
