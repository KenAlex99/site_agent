import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from './contracts.mjs';

export class BearerIdentityRegistry {
  constructor(entries = [], { role }) {
    if (!['agent', 'viewer'].includes(role)) throw new TypeError('credential role is invalid');
    this.entries = entries.map((entry, index) => normalizeCredential(entry, role, index));
  }

  authenticate(authorization) {
    const match = /^Bearer ([^\s]+)$/i.exec(String(authorization || '').trim());
    if (!match) throw unauthorized();
    const digest = hashToken(match[1]);
    let matched = null;
    for (const entry of this.entries) {
      if (timingSafeEqual(entry.digest, digest)) matched ||= entry;
    }
    if (!matched) throw unauthorized();
    return matched.identity;
  }
}

function normalizeCredential(entry, role, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`${role} credential ${index} must be an object`);
  const token = String(entry.token || '');
  if (token.length < 16 || token.length > 512) throw new TypeError(`${role} credential ${index} token must contain 16-512 characters`);
  if (role === 'agent') {
    return { digest: hashToken(token), identity: Object.freeze({ tenantId: configId(entry.tenantId, 'tenantId'), siteId: configId(entry.siteId, 'siteId'), sourceId: configId(entry.sourceId, 'sourceId') }) };
  }
  if (!Array.isArray(entry.tenantIds) || entry.tenantIds.length === 0) throw new TypeError(`viewer credential ${index} needs tenantIds`);
  return { digest: hashToken(token), identity: Object.freeze({ tenantIds: Object.freeze([...new Set(entry.tenantIds.map((item) => configId(item, 'tenantId')))]) }) };
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

function configId(value, field) {
  const normalized = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(normalized)) throw new TypeError(`${field} is invalid`);
  return normalized;
}

function unauthorized() {
  return new AppError(401, 'SITE_AGENT_UNAUTHORIZED', 'A valid bearer credential is required');
}
