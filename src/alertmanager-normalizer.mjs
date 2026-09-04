import { AppError } from './contracts.mjs';
import { normalizeAlertEventBatch, normalizeAlertSnapshotBatch } from './alert-contracts.mjs';

const reviewedLabels = new Set([
  'alertname', 'severity', 'instance', 'job',
  'device', 'device_id', 'device_name', 'hostname',
  'port', 'port_id', 'port_name', 'ifName', 'ifDescr', 'ifAlias',
  'rule', 'rule_id', 'rule_name',
  'source', 'source_id', 'service', 'service_id',
  'site', 'site_id', 'cluster', 'cluster_id'
]);
const reviewedAnnotations = new Set(['summary', 'description', 'runbook_url']);
const sensitiveKey = /(authorization|community|credential|password|secret|token)/i;
const controlCharacter = /[\u0000-\u001f\u007f]/u;

export function normalizeAlertmanagerWebhook(input, { observedAt, deliveryId } = {}) {
  object(input, 'webhook');
  const status = enumValue(input.status, new Set(['firing', 'resolved']), 'webhook.status');
  const alerts = array(input.alerts, 'webhook.alerts', 100).map((alert, index) => normalizeWebhookAlert(alert, index));
  if (alerts.length === 0) invalid('webhook.alerts must contain at least one alert');
  const normalizedObservedAt = rfc3339(observedAt, 'observedAt');
  return normalizeAlertEventBatch({
    schemaVersion: '1.0', deliveryId: identifier(deliveryId, 'deliveryId'),
    kind: 'alert-events', observedAt: normalizedObservedAt, status,
    groupKey: optionalString(input.groupKey, 'webhook.groupKey', 512),
    receiver: optionalString(input.receiver, 'webhook.receiver', 160), alerts
  }, {}, { now: Date.parse(normalizedObservedAt) });
}

export function normalizeAlertmanagerActiveAlerts(input, { observedAt, snapshotId, sequence } = {}) {
  const alerts = array(input, 'alerts', 5000).map((alert, index) => normalizeApiAlert(alert, index));
  const normalizedObservedAt = rfc3339(observedAt, 'observedAt');
  return normalizeAlertSnapshotBatch({
    schemaVersion: '1.0', snapshotId: identifier(snapshotId, 'snapshotId'), sequence,
    kind: 'alert-snapshot', observedAt: normalizedObservedAt, alerts
  }, {}, { now: Date.parse(normalizedObservedAt) });
}

function normalizeWebhookAlert(input, index) {
  const path = `webhook.alerts[${index}]`;
  object(input, path);
  return normalizedAlert({
    input, path,
    status: enumValue(input.status, new Set(['firing', 'resolved']), `${path}.status`)
  });
}

function normalizeApiAlert(input, index) {
  const path = `alerts[${index}]`;
  object(input, path);
  object(input.status, `${path}.status`);
  const state = enumValue(input.status.state, new Set(['active', 'suppressed', 'unprocessed']), `${path}.status.state`);
  const silenced = optionalStringArray(input.status.silencedBy, `${path}.status.silencedBy`);
  const inhibited = optionalStringArray(input.status.inhibitedBy, `${path}.status.inhibitedBy`);
  return normalizedAlert({
    input, path,
    status: state === 'suppressed' || silenced.length > 0 || inhibited.length > 0 ? 'suppressed' : 'firing'
  });
}

function normalizedAlert({ input, path, status }) {
  const labels = reviewedMap(input.labels, `${path}.labels`, reviewedLabels, 64, 512);
  if (!labels.alertname) invalid(`${path}.labels.alertname is required`);
  labels.severity = normalizeSeverity(labels.severity);
  const endsAt = optionalAlertEnd(input.endsAt, `${path}.endsAt`);
  return omitUndefined({
    fingerprint: identifier(input.fingerprint, `${path}.fingerprint`), status,
    startsAt: rfc3339(input.startsAt, `${path}.startsAt`), endsAt,
    labels,
    annotations: reviewedMap(input.annotations ?? {}, `${path}.annotations`, reviewedAnnotations, 32, 2000, true)
  });
}

function reviewedMap(input, path, allowlist, maxEntries, maxLength, allowEmpty = false) {
  object(input, path);
  const entries = Object.entries(input);
  if (entries.length > maxEntries) invalid(`${path} must contain at most ${maxEntries} entries`);
  const result = {};
  for (const [key, value] of entries) {
    if (sensitiveKey.test(key)) invalid(`${path}.${key} is sensitive and cannot be forwarded`);
    if (!allowlist.has(key)) continue;
    result[key] = boundedString(value, `${path}.${key}`, maxLength);
  }
  if (!allowEmpty && Object.keys(result).length === 0) invalid(`${path} does not contain reviewed labels`);
  return result;
}

function normalizeSeverity(value) {
  const severity = String(value ?? '').trim().toLowerCase();
  if (['critical', 'emergency', 'fatal', 'page', 'high'].includes(severity)) return 'critical';
  if (['warning', 'warn', 'medium'].includes(severity)) return 'warning';
  if (['info', 'informational', 'notice', 'low'].includes(severity)) return 'info';
  return 'unknown';
}

function optionalAlertEnd(value, path) {
  if (value === undefined || value === null || value === '' || /^0001-01-01T00:00:00(?:\.0+)?Z$/.test(String(value))) return undefined;
  return rfc3339(value, path);
}

function optionalStringArray(value, path) {
  if (value === undefined || value === null) return [];
  return array(value, path, 100).map((item, index) => boundedString(item, `${path}[${index}]`, 160));
}

function array(value, path, max) {
  if (!Array.isArray(value) || value.length > max) invalid(`${path} must be an array with at most ${max} items`);
  return value;
}

function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid(`${path} must be an object`);
  }
}

function optionalString(value, path, max) {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedString(value, path, max);
}

function boundedString(value, path, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalid(`${path} is invalid`);
  if (controlCharacter.test(value)) invalid(`${path} contains a control character`);
  return value;
}

function identifier(value, path) {
  const normalized = boundedString(value, path, 160).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]*$/.test(normalized) || normalized.includes('..')) invalid(`${path} is invalid`);
  return normalized;
}

function enumValue(value, allowed, path) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!allowed.has(normalized)) invalid(`${path} is invalid`);
  return normalized;
}

function rfc3339(value, path) {
  const normalized = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) invalid(`${path} must be an RFC3339 timestamp`);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) invalid(`${path} is invalid`);
  return new Date(parsed).toISOString();
}

function omitUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function invalid(message) {
  throw new AppError(400, 'ALERTMANAGER_INVALID_PAYLOAD', message);
}
