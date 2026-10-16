import { AppError } from './contracts.mjs';

const types = new Set(['processor', 'mempool', 'storage']);
function numeric(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : null;
}
function integer(value) {
  if (typeof value === 'string') {
    const match = /^(0|[1-9]\d*)(?:\.0+)?$/.exec(value);
    if (!match || match[1].length > 16 || (match[1].length === 16 && match[1] > '9007199254740991')) return null;
  }
  const number = numeric(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}
function field(value, unit, state, missingReason, basis = null, sourceField = null) {
  return { value, unit, state, missing_reason: missingReason, source_kind: 'librenms_observed', observed_at: null,
    received_at: null, capacity_basis: basis, evidence: sourceField === null ? null : { unit_verified: true, source_field: sourceField } };
}
/** Source profile is a server-side approval gate, never read from the raw object. */
export function projectCapacityFields(row, type, sourceProfile = null) {
  if (!types.has(type) || !row || typeof row !== 'object' || Array.isArray(row)) throw new AppError(400, 'CAPACITY_INVALID_ARGUMENT', 'Invalid capacity projection');
  const percentKey = type === 'processor' ? 'processor_usage' : `${type}_perc`;
  const rawPercent = row[percentKey] ?? null;
  const percent = numeric(rawPercent);
  const validPercent = percent !== null && percent <= 100;
  const percentField = field(validPercent ? percent : null, 'percent', validPercent ? 'partial' : rawPercent === null ? 'not_collected' : 'read_failed', validPercent || rawPercent === null ? 'source_field_absent' : 'contract_violation');
  if (type === 'processor') return { usage_percent: percentField,
    core_count: field(null, 'count', 'not_collected', 'source_field_absent'),
    thread_count: field(null, 'count', 'not_collected', 'source_field_absent'),
    frequency_hz: field(null, 'Hz', 'not_collected', 'source_field_absent') };
  const index = row[`${type}_index`];
  const multiplier = integer(row[type === 'mempool' ? 'mempool_precision' : 'storage_units']);
  const hasLineage = sourceProfile === 'hrstorage-normalized-v1'
    && row[type === 'mempool' ? 'mempool_type' : 'type'] === 'hrstorage'
    && (typeof index === 'number' || typeof index === 'string') && /^[1-9]\d{0,9}$/.test(String(index))
    && row[`${type}_used_oid`] === `.1.3.6.1.2.1.25.2.3.1.6.${index}`
    && [null, undefined, ''].includes(row[`${type}_perc_oid`]) && multiplier !== null && multiplier >= 1 && multiplier <= 2147483647;
  const names = [type === 'mempool' ? 'mempool_total' : 'storage_size', `${type}_used`, `${type}_free`];
  const values = names.map(name => integer(row[name]));
  const [total, used, free] = values;
  const invalid = hasLineage && (values.some(value => value === null) || total <= 0 || used > total || free > total || used + free !== total
    || (rawPercent !== null && (!validPercent || Math.abs(percent - used / total * 100) > 1.01)));
  const absolute = hasLineage && !invalid;
  const basis = absolute ? 'absolute' : 'unknown';
  const result = { capacity_basis: basis, usage_relation: 'independent' };
  ['total_bytes', 'used_bytes', 'free_bytes'].forEach((key, i) => {
    result[key] = field(absolute ? values[i] : null, 'bytes', invalid ? 'read_failed' : 'partial',
      invalid ? 'contract_violation' : absolute ? 'source_field_absent' : 'unit_unverified', basis, absolute ? names[i] : null);
  });
  result.used_percent = invalid ? field(null, 'percent', 'read_failed', 'contract_violation') : percentField;
  return result;
}
