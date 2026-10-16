import { AppError } from '../contracts.mjs';
import { projectCapacityFields } from '../device-capacity.mjs';

const types = new Set(['processor', 'mempool', 'storage']);
function invalid(code = 'CAPACITY_INVALID_ARGUMENT', status = 400) { throw new AppError(status, code, 'Capacity request could not be completed'); }
function identifier(value, code = 'CAPACITY_INVALID_ARGUMENT', status = 400) {
  if (!['number', 'string'].includes(typeof value) || !/^[1-9]\d{0,15}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) invalid(code, status);
  return String(value);
}
function bounded(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) invalid(); return value; }
function cancelled(signal, callerSignal) { if (signal.aborted) invalid(callerSignal?.aborted ? 'CAPACITY_CANCELLED' : 'CAPACITY_TIMEOUT', callerSignal?.aborted ? 499 : 504); }
function abortable(promise, signal, callerSignal) {
  cancelled(signal, callerSignal);
  return new Promise((resolve, reject) => {
    const abort = () => { try { cancelled(signal, callerSignal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export class LibreNmsCapacityProvider {
  #token;
  constructor({ baseUrl, token = '', sourceProfile = null, timeoutMs = 10000, maxResponseBytes = 1048576, fetchImpl = fetch } = {}) {
    let url;
    try { url = new URL(baseUrl); } catch { invalid(); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
      || typeof token !== 'string' || /[\r\n]/.test(token) || typeof fetchImpl !== 'function' || ![null, 'hrstorage-normalized-v1'].includes(sourceProfile)) invalid();
    this.baseUrl = url.origin;
    this.#token = token;
    this.sourceProfile = sourceProfile;
    this.timeoutMs = bounded(timeoutMs, 50, 10000);
    this.maxResponseBytes = bounded(maxResponseBytes, 1024, 1048576);
    this.fetchImpl = fetchImpl;
  }
  async readResourcePage(deviceId, type, options = {}) {
    const id = identifier(deviceId);
    if (!types.has(type) || !options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['page', 'pageSize', 'signal'].includes(key))) invalid();
    const page = bounded(options.page ?? 1, 1, 100000);
    const pageSize = bounded(options.pageSize ?? 10, 1, 20);
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) invalid();
    if (!this.#token) invalid('CAPACITY_NOT_CONFIGURED', 503);
    const deadline = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    const budget = { bytes: 0 };
    try {
      cancelled(signal, options.signal);
      const path = `/devices/${id}/health/${type}`;
      const directory = await this.#request(path, signal, options.signal, budget);
      const ids = directory.map(row => identifier(row?.sensor_id, 'CAPACITY_INVALID_RESPONSE', 502));
      if (new Set(ids).size !== ids.length) invalid('CAPACITY_INVALID_RESPONSE', 502);
      ids.sort((a, b) => Number(a) - Number(b));
      const items = [];
      for (const resourceId of ids.slice((page - 1) * pageSize, page * pageSize)) {
        const rows = await this.#request(`${path}/${resourceId}`, signal, options.signal, budget);
        if (rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object' || Array.isArray(rows[0])) invalid('CAPACITY_INVALID_RESPONSE', 502);
        const row = rows[0];
        if (identifier(row.device_id, 'CAPACITY_SCOPE_MISMATCH', 502) !== id || identifier(row[`${type}_id`], 'CAPACITY_SCOPE_MISMATCH', 502) !== resourceId) invalid('CAPACITY_SCOPE_MISMATCH', 502);
        items.push({ id: resourceId, label: `${type} ${resourceId}`, fields: projectCapacityFields(row, type, this.sourceProfile) });
      }
      cancelled(signal, options.signal);
      return { schema_version: 1, device_id: id, resource_type: type, page, page_size: pageSize, total: ids.length, coverage: 'page', snapshot_consistency: 'unverified', observed_at: null, received_at: null, items };
    } finally { clearTimeout(timer); }
  }
  async #request(path, signal, callerSignal, budget) {
    cancelled(signal, callerSignal);
    let response;
    try { response = await abortable(this.fetchImpl(`${this.baseUrl}/api/v0${path}`, { method: 'GET', redirect: 'error', headers: { 'X-Auth-Token': this.#token, accept: 'application/json' }, signal }), signal, callerSignal); }
    catch (error) { if (error instanceof AppError) throw error; cancelled(signal, callerSignal); invalid('CAPACITY_PROVIDER_UNAVAILABLE', 502); }
    cancelled(signal, callerSignal);
    const rejectResponse = (code, status) => { if (response.body) void response.body.cancel().catch(() => {}); invalid(code, status); };
    if (response.status === 404) rejectResponse('CAPACITY_NOT_FOUND', 404);
    if (response.status === 401 || response.status === 403) rejectResponse('CAPACITY_PROVIDER_DENIED', 403);
    if (response.status !== 200) rejectResponse('CAPACITY_PROVIDER_REJECTED', 502);
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) rejectResponse('CAPACITY_INVALID_RESPONSE', 502);
    if (Number(response.headers.get('content-length')) > this.maxResponseBytes) rejectResponse('CAPACITY_RESPONSE_LIMIT', 502);
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await abortable(reader.read(), signal, callerSignal);
        if (done) break;
        size += value.byteLength; budget.bytes += value.byteLength;
        if (size > this.maxResponseBytes || budget.bytes > 2097152) invalid('CAPACITY_RESPONSE_LIMIT', 502);
        chunks.push(value);
      }
    } catch (error) { if (error instanceof AppError) throw error; cancelled(signal, callerSignal); invalid('CAPACITY_INVALID_RESPONSE', 502); }
    finally { void reader.cancel().catch(() => {}); }
    cancelled(signal, callerSignal);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { invalid('CAPACITY_INVALID_RESPONSE', 502); }
    if (!body || body.status !== 'ok' || !Array.isArray(body.graphs) || body.graphs.length > 100) invalid('CAPACITY_INVALID_RESPONSE', 502);
    return body.graphs;
  }
}
