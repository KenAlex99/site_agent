import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse } from 'node:path';

const ATTEMPT_FILE = 'enrollment-attempt.json';
const IDENTITY_FILE = 'edge-identity.json';
const MAX_IDENTITY_BYTES = 4096;

export async function createSiteAgentIdentityStore({ directory } = {}) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
    throw new Error('Identity storage is supported only on Linux');
  }
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw new TypeError('Identity storage directory must be an absolute path');
  }
  await assertSecureDirectory(directory);
  return Object.freeze({
    load: () => loadIdentity(directory),
    beginAttempt: (attemptId, startedAt) => beginAttempt(directory, attemptId, startedAt),
    save: (identity) => saveIdentity(directory, identity)
  });
}

async function assertSecureDirectory(directory) {
  const normalized = directory.replace(/[\\/]+$/u, '') || parse(directory).root;
  if (await realpath(normalized) !== normalized) throw new Error('Identity storage path is not canonical');
  const uid = process.getuid();
  const components = [];
  let current = normalized;
  while (true) {
    components.unshift(current);
    const parent = parse(current).root === current ? current : join(current, '..');
    if (parent === current) break;
    current = parent;
  }
  for (const path of components) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0
      || (info.uid !== 0 && info.uid !== uid)) {
      throw new Error('Identity storage path permissions are unsafe');
    }
  }
  const leaf = await lstat(normalized);
  if (leaf.uid !== uid || (leaf.mode & 0o777) !== 0o700) {
    throw new Error('Identity storage directory must be owned by the service user with mode 0700');
  }
}

async function beginAttempt(directory, attemptId, startedAt) {
  if (!isUuid(attemptId) || typeof startedAt !== 'string' || !Number.isFinite(Date.parse(startedAt))) {
    throw new TypeError('Enrollment attempt is invalid');
  }
  try {
    await lstat(join(directory, IDENTITY_FILE));
    throw new Error('An identity already exists; refusing to register again');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const record = JSON.stringify({ format_version: 1, attempt_id: attemptId, started_at: startedAt });
  await createExclusive(directory, ATTEMPT_FILE, record);
}

async function saveIdentity(directory, identity) {
  validateIdentity(identity);
  const record = JSON.stringify({ format_version: 1, ...identity });
  if (Buffer.byteLength(record, 'utf8') > MAX_IDENTITY_BYTES) throw new Error('Issued identity is invalid');
  await createExclusive(directory, IDENTITY_FILE, record);
  return Object.freeze({ edge_id: identity.edge_id, scopes: ['ingest'], issued_at: identity.issued_at });
}

async function createExclusive(directory, name, value) {
  const path = join(directory, name);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await open(path, flags, 0o600);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    const dir = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
    try { await dir.sync(); } finally { await dir.close(); }
  } catch {
    await handle?.close().catch(() => {});
    throw new Error('Identity storage operation failed; operator recovery is required');
  }
}

async function loadIdentity(directory) {
  const path = join(directory, IDENTITY_FILE);
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw new Error('Identity storage could not be inspected'); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid()
    || (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > MAX_IDENTITY_BYTES) {
    throw new Error('Identity file permissions or shape are unsafe');
  }
  let parsed;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid()
      || (opened.mode & 0o777) !== 0o600 || opened.size < 1 || opened.size > MAX_IDENTITY_BYTES) {
      throw new Error();
    }
    parsed = JSON.parse(await handle.readFile('utf8'));
  } catch { throw new Error('Identity file is invalid'); }
  finally { await handle?.close(); }
  if (!parsed || parsed.format_version !== 1) throw new Error('Identity file is invalid');
  validateIdentity(parsed);
  return Object.freeze(parsed);
}

function validateIdentity(value) {
  const expected = ['center_origin', 'edge_id', 'enrollment_attempt_id', 'format_version', 'issued_at', 'scopes', 'uplink_credential'];
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join('|') !== expected.sort().join('|')
    || value.format_version !== 1
    || !validCenterOrigin(value.center_origin)
    || !/^edge_[A-Za-z0-9_-]{22,120}$/u.test(value.edge_id || '')
    || !isUuid(value.enrollment_attempt_id)
    || typeof value.uplink_credential !== 'string' || value.uplink_credential.length < 32
    || value.uplink_credential.length > 512 || /[\u0000-\u0020\u007f]/u.test(value.uplink_credential)
    || !Array.isArray(value.scopes) || value.scopes.length !== 1 || value.scopes[0] !== 'ingest'
    || typeof value.issued_at !== 'string' || !value.issued_at.endsWith('Z') || !Number.isFinite(Date.parse(value.issued_at))) {
    throw new Error('Issued identity is invalid');
  }
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function validCenterOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === value && url.pathname === '/' && !url.search && !url.hash
      && !url.username && !url.password
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}

