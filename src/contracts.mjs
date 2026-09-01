export class AppError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

const identifierPattern = /^[\p{L}\p{N}_.:@/ -]{1,160}$/u;

export function requireIdentifier(value, field) {
  const normalized = String(value ?? '').trim();
  if (!identifierPattern.test(normalized) || normalized.includes('..')) {
    throw new AppError(400, 'MONITORING_INVALID_ARGUMENT', `${field} is invalid`);
  }
  return normalized;
}

export function finiteNumber(...values) {
  for (const value of values) {
    if (value === '' || value === null || value === undefined) continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

export function isoTime(value) {
  const numeric = typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value ?? '').trim())
    ? Number(value)
    : null;
  const input = numeric !== null && Number.isFinite(numeric) && numeric < 100_000_000_000
    ? numeric * 1000
    : value;
  const date = input ? new Date(input) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

export function normalizeState(value, truthy = 'up', falsy = 'down') {
  if (value === true || value === 1 || value === '1' || value === 'up' || value === 'ok') return truthy;
  if (value === false || value === 0 || value === '0' || value === 'down' || value === 'critical') return falsy;
  return String(value || 'unknown').toLowerCase();
}

export function normalizeSeverity(value) {
  const severity = String(value || 'unknown').toLowerCase();
  if (['critical', 'warning', 'ok', 'info'].includes(severity)) return severity;
  if (severity === 'error' || severity === 'emergency') return 'critical';
  return 'unknown';
}

export function publicError(error, requestId) {
  if (error instanceof AppError) {
    return { status: error.status, body: { code: error.code, message: error.message, requestId } };
  }
  return { status: 502, body: { code: 'MONITORING_UPSTREAM_UNAVAILABLE', message: 'Monitoring data is temporarily unavailable', requestId } };
}
