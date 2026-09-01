import { isIP } from 'node:net';
import { AppError } from './contracts.mjs';

const batchKeys = new Set(['schemaVersion', 'batchId', 'sequence', 'kind', 'observedAt', 'tenantId', 'siteId', 'sourceId', 'devices', 'ports']);
const deviceKeys = new Set(['localDeviceId', 'name', 'hostname', 'ip', 'status', 'os', 'hardware', 'location', 'uptimeSeconds', 'polledAt']);
const portKeys = new Set(['localPortId', 'localDeviceId', 'name', 'description', 'group', 'status', 'adminStatus', 'macAddress', 'speedBps', 'rxBps', 'txBps', 'errors', 'discards', 'polledAt']);
const states = new Set(['up', 'down', 'disabled', 'warning', 'unknown']);

export function normalizeSiteAgentBatch(input, identity, { now = Date.now() } = {}) {
  if (!plainObject(input)) invalid('batch must be a JSON object');
  allowedKeys(input, batchKeys, 'batch');
  assertIdentity(input, identity);
  if (input.schemaVersion !== '1.0') invalid('schemaVersion must be 1.0');
  if (input.kind !== 'snapshot') invalid('kind must be snapshot');
  const observedAt = timestamp(input.observedAt, 'observedAt');
  if (Date.parse(observedAt) > now + 5 * 60_000) invalid('observedAt is too far in the future');
  const devices = objectArray(input.devices, 'devices', 1000).map(normalizeDevice);
  const ports = objectArray(input.ports, 'ports', 5000).map(normalizePort);
  unique(devices, 'localDeviceId', 'devices');
  unique(ports, 'localPortId', 'ports');
  const deviceIds = new Set(devices.map((item) => item.localDeviceId));
  for (const port of ports) if (!deviceIds.has(port.localDeviceId)) invalid(`port ${port.localPortId} references an unknown device`);
  return {
    schemaVersion: '1.0',
    batchId: id(input.batchId, 'batchId'),
    sequence: integer(input.sequence, 'sequence', 1, Number.MAX_SAFE_INTEGER),
    kind: 'snapshot', observedAt, devices, ports
  };
}

function normalizeDevice(input, index) {
  allowedKeys(input, deviceKeys, `devices[${index}]`);
  const result = {
    localDeviceId: id(input.localDeviceId, `devices[${index}].localDeviceId`),
    name: text(input.name, `devices[${index}].name`, 255),
    hostname: optionalText(input.hostname, `devices[${index}].hostname`, 255),
    ip: optionalIp(input.ip, `devices[${index}].ip`),
    status: state(input.status, `devices[${index}].status`),
    os: optionalText(input.os, `devices[${index}].os`, 120),
    hardware: optionalText(input.hardware, `devices[${index}].hardware`, 255),
    location: optionalText(input.location, `devices[${index}].location`, 255),
    uptimeSeconds: optionalNumber(input.uptimeSeconds, `devices[${index}].uptimeSeconds`, true),
    polledAt: optionalTimestamp(input.polledAt, `devices[${index}].polledAt`)
  };
  return omitUndefined(result);
}

function normalizePort(input, index) {
  allowedKeys(input, portKeys, `ports[${index}]`);
  const result = {
    localPortId: id(input.localPortId, `ports[${index}].localPortId`),
    localDeviceId: id(input.localDeviceId, `ports[${index}].localDeviceId`),
    name: text(input.name, `ports[${index}].name`, 255),
    description: optionalText(input.description, `ports[${index}].description`, 500),
    group: optionalText(input.group, `ports[${index}].group`, 120),
    status: state(input.status, `ports[${index}].status`),
    adminStatus: input.adminStatus === undefined ? undefined : state(input.adminStatus, `ports[${index}].adminStatus`),
    macAddress: optionalMac(input.macAddress, `ports[${index}].macAddress`),
    speedBps: optionalNumber(input.speedBps, `ports[${index}].speedBps`),
    rxBps: optionalNumber(input.rxBps, `ports[${index}].rxBps`),
    txBps: optionalNumber(input.txBps, `ports[${index}].txBps`),
    errors: optionalNumber(input.errors, `ports[${index}].errors`, true),
    discards: optionalNumber(input.discards, `ports[${index}].discards`, true),
    polledAt: optionalTimestamp(input.polledAt, `ports[${index}].polledAt`)
  };
  return omitUndefined(result);
}

function assertIdentity(input, identity) {
  for (const field of ['tenantId', 'siteId', 'sourceId']) {
    if (input[field] !== undefined && input[field] !== identity[field]) {
      throw new AppError(403, 'SITE_AGENT_IDENTITY_MISMATCH', `${field} does not match the authenticated source`);
    }
  }
}

function allowedKeys(value, allowed, path) {
  if (!plainObject(value)) invalid(`${path} must be an object`);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) invalid(`${path}.${unknown} is not allowed`);
}

function objectArray(value, field, max) {
  if (!Array.isArray(value) || value.length > max) invalid(`${field} must be an array with at most ${max} items`);
  if (value.some((item) => !plainObject(item))) invalid(`${field} contains a non-object item`);
  return value;
}

function id(value, field) {
  const normalized = String(value ?? '').trim();
  if (!/^[\p{L}\p{N}_.:@/ -]{1,160}$/u.test(normalized) || normalized.includes('..')) invalid(`${field} is invalid`);
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

function optionalIp(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value).trim();
  if (!isIP(normalized)) invalid(`${field} is invalid`);
  return normalized;
}

function optionalMac(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase().replaceAll('-', ':');
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalized)) invalid(`${field} is invalid`);
  return normalized;
}

function state(value, field) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!states.has(normalized)) invalid(`${field} is invalid`);
  return normalized;
}

function optionalNumber(value, field, whole = false) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0 || (whole && !Number.isInteger(normalized))) invalid(`${field} is invalid`);
  return normalized;
}

function integer(value, field, min, max) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) invalid(`${field} is invalid`);
  return normalized;
}

function optionalTimestamp(value, field) {
  return value === undefined || value === null || value === '' ? undefined : timestamp(value, field);
}

function timestamp(value, field) {
  const normalized = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) invalid(`${field} must be an ISO 8601 timestamp with timezone`);
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) invalid(`${field} is invalid`);
  return new Date(epoch).toISOString();
}

function unique(items, key, field) {
  if (new Set(items.map((item) => item[key])).size !== items.length) invalid(`${field} contains duplicate ${key}`);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function invalid(message) {
  throw new AppError(400, 'SITE_AGENT_INVALID_BATCH', message);
}
