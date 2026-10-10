import { AppError } from './contracts.mjs';

const FIELD_PATTERN = /^[A-Za-z0-9_.\[\]-]{1,160}$/;
const FORBIDDEN_SEGMENT = /^(?:__proto__|prototype|constructor|community|notes?|password|passwd|passphrase|credential|credentials|secret|secrets|(?:api[_-]?)?tokens?|api[_-]?key|auth(?:entication)?(?:[_-]?(?:key|pass|password|phrase|token|secret|algo|algorithm))?|priv(?:acy)?(?:[_-]?(?:key|pass|password|phrase|token|secret|algo|algorithm))?|snmp[_-]?(?:auth|priv).*)$/i;

export function parseAttributeFields(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const fields = [...new Set(String(value).split(',').map((field) => field.trim()).filter(Boolean))];
  if (fields.length > 100 || fields.some((field) => !FIELD_PATTERN.test(field))) {
    throw new AppError(400, 'MONITORING_INVALID_ARGUMENT', 'fields must contain at most 100 valid attribute paths');
  }
  return new Set(fields);
}

export function projectDeviceAttributes(raw, options = {}) {
  const settings = {
    fields: options.fields ?? null,
    maxItems: bounded(options.maxItems, 1, 1000, 500),
    maxDepth: bounded(options.maxDepth, 1, 8, 5),
    maxStringLength: bounded(options.maxStringLength, 16, 8192, 2048)
  };
  const items = [];
  let capacityOmitted = 0;
  let visited = 0;

  visit(raw, '', 0);
  items.sort((left, right) => left.key.localeCompare(right.key, 'en', { numeric: true }));
  const selected = settings.fields ? items.filter((item) => settings.fields.has(item.key)) : items;
  const limited = selected.slice(0, settings.maxItems);
  capacityOmitted += Math.max(0, selected.length - limited.length);
  return {
    total: limited.length,
    available: items.length,
    requestedFields: settings.fields?.size ?? null,
    truncated: capacityOmitted > 0,
    items: limited
  };

  function visit(value, path, depth) {
    visited += 1;
    if (visited > 5000) { capacityOmitted += 1; return; }
    if (path && isForbiddenPath(path)) return;
    if (depth > settings.maxDepth) { capacityOmitted += 1; return; }
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      if (!path) return;
      const normalized = scalar(value, settings.maxStringLength);
      items.push({ key: path, category: path.match(/^[^.\[]+/)?.[0] || 'other', type: normalized.type, value: normalized.value });
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < Math.min(value.length, 100); index += 1) visit(value[index], `${path}[${index}]`, depth + 1);
      if (value.length > 100) capacityOmitted += value.length - 100;
      return;
    }
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) { capacityOmitted += 1; return; }
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))) {
      visit(value[key], path ? `${path}.${key}` : key, depth + 1);
    }
  }
}

function isForbiddenPath(path) {
  return path.split(/[.\[\]]/).filter(Boolean).some((segment) => FORBIDDEN_SEGMENT.test(segment));
}

function scalar(value, maxStringLength) {
  if (value === null) return { type: 'null', value: null };
  if (typeof value === 'string') return { type: 'string', value: value.slice(0, maxStringLength) };
  if (typeof value === 'number') return Number.isFinite(value) ? { type: 'number', value } : { type: 'null', value: null };
  return { type: 'boolean', value };
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
