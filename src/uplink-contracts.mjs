import { AppError } from './contracts.mjs';

const MAX_ENVELOPE_BYTES = 256 * 1024;
const envelopeKeys = new Set([
  'module', 'edge_id', 'asset_id', 'source_identity', 'ts', 'type', 'payload', 'idempotency_key'
]);
const sourceIdentityKeys = new Set(['edge_id', 'system', 'object_type', 'identifier_kind', 'external_id']);
const ingestTypes = new Set(['alert', 'log', 'config', 'log_sync_observation', 'monitoring_observation']);
const sourceSystems = new Set(['netxms', 'librenms', 'oxidized', 'netbox', 'syslog', 'manual', 'excel_import', 'aiops']);
const objectTypes = new Set(['device', 'port', 'site', 'config_object', 'log_source']);
const identifierKinds = new Set([
  'librenms_device_id', 'port_id', 'ip', 'sysname', 'mac', 'sysObjectID', 'oxidized_node_name', 'manual_reference'
]);
const assetIdPattern = /^asst_[0-9A-HJKMNP-TV-Z]{26}$/;
const utcMillisecondPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

export function normalizeUplinkEnvelope(input, { edgeId } = {}) {
  opaqueText(edgeId, 'configured edge identity', 1, 128);
  if (!plainObject(input)) invalid('envelope must be a JSON object');
  allowedKeys(input, envelopeKeys, 'envelope');

  const wireEdgeId = opaqueText(input.edge_id, 'edge_id', 1, 128);
  if (wireEdgeId !== edgeId) invalid('edge_id does not match the configured edge identity');

  opaqueText(input.module, 'module', 1, Number.MAX_SAFE_INTEGER);
  if (!ingestTypes.has(input.type)) invalid('type is not a registered non-metric ingest type');
  timestamp(input.ts, 'ts');
  opaqueText(input.idempotency_key, 'idempotency_key', 8, 128);
  if (!plainObject(input.payload)) invalid('payload must be a JSON object');

  const hasAsset = input.asset_id !== undefined && input.asset_id !== null;
  const hasSource = input.source_identity !== undefined;
  if (!hasAsset && !hasSource) invalid('asset_id or source_identity is required');
  if (hasAsset && !assetIdPattern.test(input.asset_id)) invalid('asset_id is invalid');
  if (input.asset_id === null && !hasSource) invalid('asset_id or source_identity is required');
  if (hasSource) validateSourceIdentity(input.source_identity, edgeId);

  validateJsonValue(input.payload, 'payload', new WeakSet(), 0);
  let serialized;
  try { serialized = JSON.stringify(input); }
  catch { invalid('payload must be JSON serializable'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ENVELOPE_BYTES) {
    invalid('envelope must not exceed 256 KiB');
  }
  return JSON.parse(serialized);
}

function validateSourceIdentity(value, edgeId) {
  if (!plainObject(value)) invalid('source_identity must be a JSON object');
  allowedKeys(value, sourceIdentityKeys, 'source_identity');
  for (const key of sourceIdentityKeys) {
    if (!(key in value)) invalid(`source_identity.${key} is required`);
  }
  const sourceEdgeId = opaqueText(value.edge_id, 'source_identity.edge_id', 1, 128);
  if (sourceEdgeId !== edgeId) invalid('source_identity.edge_id does not match the configured edge identity');
  enumValue(value.system, sourceSystems, 'source_identity.system');
  enumValue(value.object_type, objectTypes, 'source_identity.object_type');
  enumValue(value.identifier_kind, identifierKinds, 'source_identity.identifier_kind');
  opaqueText(value.external_id, 'source_identity.external_id', 1, 256);
}

function validateJsonValue(value, path, seen, depth) {
  if (depth > 64) invalid(`${path} exceeds the JSON nesting limit`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${path} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== 'object') invalid(`${path} must contain only JSON values`);
  if (seen.has(value)) invalid(`${path} must not contain circular references`);
  if (!Array.isArray(value) && !plainObject(value)) invalid(`${path} must contain only plain JSON objects`);
  if (Object.getOwnPropertySymbols(value).length > 0) invalid(`${path} must not contain symbol keys`);

  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) invalid(`${path} must not contain sparse arrays`);
      validateJsonValue(value[index], `${path}[${index}]`, seen, depth + 1);
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      validateJsonValue(item, `${path}.${key}`, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function allowedKeys(value, allowed, path) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) invalid(`${path}.${unknown} is not allowed`);
}

function enumValue(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.has(value)) invalid(`${field} is invalid`);
  return value;
}

function opaqueText(value, field, min, max) {
  if (
    typeof value !== 'string'
    || value.length < min
    || value.length > max
    || value !== value.trim()
    || controlCharacters.test(value)
  ) {
    invalid(`${field} is invalid`);
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !utcMillisecondPattern.test(value)) invalid(`${field} must use UTC millisecond RFC 3339`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) invalid(`${field} is invalid`);
  return value;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function invalid(message) {
  throw new AppError(400, 'UPLINK_INVALID_ENVELOPE', message);
}
