import { AppError } from './contracts.mjs';

const naiveDateTime = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
const absoluteDateTime = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const probeOffsets = [-172_800_000, -86_400_000, 0, 86_400_000, 172_800_000];
const formatterCache = new Map();

export function requireIanaTimeZone(value) {
  const timeZone = String(value || '').trim();
  if (!timeZone) configurationError();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch {
    configurationError();
  }
  return timeZone;
}

export function formatLibreNmsLocalTime(value, timeZoneValue) {
  const timeZone = requireIanaTimeZone(timeZoneValue);
  const epochMs = Date.parse(String(value || ''));
  if (!Number.isFinite(epochMs)) {
    throw new AppError(400, 'MONITORING_INVALID_ARGUMENT', 'Alert history requires valid ISO 8601 timestamps');
  }
  const parts = zonedParts(epochMs, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function parseLibreNmsTime(value, timeZoneValue) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  if (absoluteDateTime.test(raw)) return absoluteTime(raw);

  const match = naiveDateTime.exec(raw);
  if (!match) invalidResponse();
  const local = {
    year: match[1], month: match[2], day: match[3], hour: match[4], minute: match[5], second: match[6]
  };
  const millisecond = Number(String(match[7] || '').padEnd(3, '0'));
  const localEpochMs = Date.UTC(
    Number(local.year), Number(local.month) - 1, Number(local.day),
    Number(local.hour), Number(local.minute), Number(local.second), millisecond
  );
  if (!isRealCalendarTime(localEpochMs, local, millisecond)) invalidResponse();

  const timeZone = requireIanaTimeZone(timeZoneValue);
  const offsets = new Set(probeOffsets.map((delta) => offsetAt(localEpochMs + delta, timeZone)));
  const candidates = [...offsets]
    .map((offset) => localEpochMs - offset)
    .filter((candidate) => sameParts(zonedParts(candidate, timeZone), local))
    .sort((left, right) => left - right);
  if (candidates.length === 0) invalidResponse();
  return new Date(candidates[0]).toISOString();
}

function formatter(timeZone) {
  let value = formatterCache.get(timeZone);
  if (value) return value;
  value = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  formatterCache.set(timeZone, value);
  return value;
}

function zonedParts(epochMs, timeZone) {
  const values = {};
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return values;
}

function offsetAt(epochMs, timeZone) {
  const parts = zonedParts(epochMs, timeZone);
  const representedAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return representedAsUtc - Math.floor(epochMs / 1000) * 1000;
}

function sameParts(left, right) {
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].every((key) => left[key] === right[key]);
}

function isRealCalendarTime(epochMs, local, millisecond) {
  const date = new Date(epochMs);
  return date.getUTCFullYear() === Number(local.year)
    && date.getUTCMonth() + 1 === Number(local.month)
    && date.getUTCDate() === Number(local.day)
    && date.getUTCHours() === Number(local.hour)
    && date.getUTCMinutes() === Number(local.minute)
    && date.getUTCSeconds() === Number(local.second)
    && date.getUTCMilliseconds() === millisecond;
}

function absoluteTime(raw) {
  const epochMs = Date.parse(raw);
  if (!Number.isFinite(epochMs)) invalidResponse();
  return new Date(epochMs).toISOString();
}

function configurationError() {
  throw new AppError(503, 'MONITORING_PROVIDER_NOT_CONFIGURED', 'LibreNMS time zone is not configured with a valid IANA name');
}

function invalidResponse() {
  throw new AppError(502, 'MONITORING_PROVIDER_INVALID_RESPONSE', 'LibreNMS returned an invalid alert history timestamp');
}
