import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const allowedStates = new Set(['up', 'down', 'disabled', 'warning', 'unknown']);

export function loadSiteAgentClientConfig(env = process.env) {
  const token = String(env.SITE_AGENT_TOKEN || '');
  if (token.length < 16) throw new Error('SITE_AGENT_TOKEN must contain at least 16 characters');
  return {
    cloudUrl: httpUrl(env.SITE_AGENT_CLOUD_URL, 'SITE_AGENT_CLOUD_URL'),
    localUrl: httpUrl(env.SITE_AGENT_LOCAL_URL || 'http://127.0.0.1:4310', 'SITE_AGENT_LOCAL_URL'),
    token,
    sequence: optionalInteger(env.SITE_AGENT_SEQUENCE, 'SITE_AGENT_SEQUENCE', 1, Number.MAX_SAFE_INTEGER),
    timeoutMs: integer(env.SITE_AGENT_TIMEOUT_MS || 15_000, 'SITE_AGENT_TIMEOUT_MS', 1_000, 120_000),
    pageSize: integer(env.SITE_AGENT_PAGE_SIZE || 200, 'SITE_AGENT_PAGE_SIZE', 1, 200)
  };
}

export async function runSiteAgentOnce(config, {
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  uuid = randomUUID
} = {}) {
  validateRuntimeConfig(config);
  const [devices, ports] = await Promise.all([
    collectDevices(config, fetchImpl),
    collectPorts(config, fetchImpl)
  ]);
  const observedAt = new Date(clock()).toISOString();
  const batch = {
    schemaVersion: '1.0',
    batchId: uuid(),
    sequence: config.sequence ?? clock(),
    kind: 'snapshot',
    observedAt,
    devices: devices.map(mapDevice),
    ports: ports.map(mapPort)
  };
  const response = await requestJson(`${config.cloudUrl}/api/v1/site-agent/batches`, {
    fetchImpl,
    timeoutMs: config.timeoutMs,
    label: 'cloud upload',
    options: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(batch)
    }
  });
  return omitUndefined({
    accepted: Boolean(response.accepted),
    duplicate: Boolean(response.duplicate),
    applied: Boolean(response.applied),
    outOfOrder: response.outOfOrder === undefined ? undefined : Boolean(response.outOfOrder),
    sourceId: response.sourceId === undefined ? undefined : String(response.sourceId),
    batchId: batch.batchId,
    sequence: batch.sequence,
    deviceCount: batch.devices.length,
    portCount: batch.ports.length
  });
}

async function collectDevices(config, fetchImpl) {
  const body = await requestJson(`${config.localUrl}/api/v1/monitoring/devices`, {
    fetchImpl, timeoutMs: config.timeoutMs, label: 'local devices'
  });
  if (!plainObject(body) || !Array.isArray(body.items)) {
    throw new Error('Site Agent local devices response must contain an items array');
  }
  return body.items;
}

async function collectPorts(config, fetchImpl) {
  const ports = [];
  let page = 1;
  let expectedTotal = null;
  while (expectedTotal === null || ports.length < expectedTotal) {
    const query = new URLSearchParams({
      status: 'all', page: String(page), pageSize: String(config.pageSize), sort: 'id', order: 'asc'
    });
    const body = await requestJson(`${config.localUrl}/api/v1/monitoring/ports?${query}`, {
      fetchImpl, timeoutMs: config.timeoutMs, label: `local ports page ${page}`
    });
    if (!plainObject(body) || !Array.isArray(body.items) || !Number.isSafeInteger(Number(body.total)) || Number(body.total) < 0) {
      throw new Error(`Site Agent local ports response for page ${page} is invalid`);
    }
    if (expectedTotal === null) expectedTotal = Number(body.total);
    if (Number(body.total) !== expectedTotal) throw new Error('Site Agent local ports total changed during collection');
    ports.push(...body.items);
    if (ports.length >= expectedTotal) break;
    if (body.items.length === 0) throw new Error(`Site Agent local ports page ${page} ended before total was reached`);
    page += 1;
  }
  if (ports.length !== expectedTotal) throw new Error('Site Agent local ports response exceeded the declared total');
  return ports;
}

function mapDevice(device) {
  const localDeviceId = requiredId(device?.id, 'device id');
  const hostname = optionalText(device.hostname);
  const result = {
    localDeviceId,
    name: optionalText(device.name) || hostname || localDeviceId,
    hostname,
    ip: hostname && isIP(hostname) ? hostname : undefined,
    status: device.disabled ? 'disabled' : state(device.status),
    os: optionalText(device.os),
    hardware: optionalText(device.hardware),
    location: optionalText(device.location),
    uptimeSeconds: nonNegativeNumber(device.uptimeSeconds, true),
    polledAt: timestamp(device.lastPolledAt)
  };
  return omitUndefined(result);
}

function mapPort(port) {
  const localPortId = requiredId(port?.id, 'port id');
  const localDeviceId = requiredId(port?.deviceId, `port ${localPortId} device id`);
  return omitUndefined({
    localPortId,
    localDeviceId,
    name: optionalText(port.name) || localPortId,
    description: optionalText(port.description),
    group: optionalText(port.group),
    status: state(port.status),
    adminStatus: port.adminStatus === undefined || port.adminStatus === null ? undefined : state(port.adminStatus),
    macAddress: macAddress(port.macAddress),
    speedBps: nonNegativeNumber(port.speedBps),
    rxBps: nonNegativeNumber(port.rxBps),
    txBps: nonNegativeNumber(port.txBps),
    errors: nonNegativeNumber(port.errors, true),
    discards: nonNegativeNumber(port.discards, true),
    polledAt: timestamp(port.polledAt)
  });
}

async function requestJson(url, { fetchImpl, timeoutMs, label, options = {} }) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`Site Agent ${label} request failed`, { cause: error });
  }
  if (!response?.ok) throw new Error(`Site Agent ${label} failed with HTTP ${response?.status ?? 'unknown'}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Site Agent ${label} returned invalid JSON`, { cause: error });
  }
}

function validateRuntimeConfig(config) {
  if (!plainObject(config)) throw new Error('Site Agent configuration is invalid');
  httpUrl(config.cloudUrl, 'SITE_AGENT_CLOUD_URL');
  httpUrl(config.localUrl, 'SITE_AGENT_LOCAL_URL');
  if (String(config.token || '').length < 16) throw new Error('SITE_AGENT_TOKEN must contain at least 16 characters');
  integer(config.timeoutMs, 'SITE_AGENT_TIMEOUT_MS', 1_000, 120_000);
  integer(config.pageSize, 'SITE_AGENT_PAGE_SIZE', 1, 200);
  if (config.sequence !== undefined) integer(config.sequence, 'SITE_AGENT_SEQUENCE', 1, Number.MAX_SAFE_INTEGER);
}

function httpUrl(value, field) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch { throw new Error(`${field} must be an absolute HTTP URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${field} must be an absolute HTTP URL without credentials, query, or fragment`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function optionalInteger(value, field, min, max) {
  return value === undefined || value === null || value === '' ? undefined : integer(value, field, min, max);
}

function integer(value, field, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return number;
}

function requiredId(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`Site Agent ${field} is missing`);
  return normalized;
}

function optionalText(value) {
  const normalized = value === undefined || value === null ? '' : String(value).trim();
  return normalized || undefined;
}

function state(value) {
  const normalized = String(value ?? 'unknown').trim().toLowerCase();
  return allowedStates.has(normalized) ? normalized : 'unknown';
}

function nonNegativeNumber(value, whole = false) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && (!whole || Number.isInteger(number)) ? number : undefined;
}

function timestamp(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const epoch = Date.parse(String(value));
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : undefined;
}

function macAddress(value) {
  const normalized = optionalText(value)?.toLowerCase().replaceAll('-', ':');
  return normalized && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalized) ? normalized : undefined;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
