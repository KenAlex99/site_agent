import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
const types = new Set(['processor', 'mempool', 'storage']);
const digest = value => createHash('sha256').update(value).digest();
const validId = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': bytes.length }); res.end(bytes);
}
/** Explicit service-only read boundary. No default main/collector registration. Bind only on loopback. */
export function createCapacityHttpServer({ token, deviceIds, provider, timeoutMs = 10000 } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(token) || !Array.isArray(deviceIds) || !deviceIds.length || deviceIds.length > 10000 || !deviceIds.every(validId) || typeof provider?.getDeviceCapacityPage !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new TypeError('Capacity HTTP configuration is invalid');
  const allowed = new Set(deviceIds), secret = digest('Bearer ' + token);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://capacity.local');
    const match = /^\/api\/v1\/monitoring\/devices\/([1-9]\d{0,15})\/capacity\/([a-z]+)$/.exec(url.pathname);
    if (!match || !validId(match[1]) || !types.has(match[2])) return json(res, 404, { code: 'CAPACITY_NOT_FOUND' });
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || auth.length > 1024 || !timingSafeEqual(digest(auth), secret)) return json(res, 401, { code: 'CAPACITY_AUTH_REQUIRED' });
    if (req.method !== 'GET') return json(res, 405, { code: 'CAPACITY_READ_ONLY' });
    if (!allowed.has(match[1])) return json(res, 404, { code: 'CAPACITY_NOT_FOUND' });
    for (const name of url.searchParams.keys()) if (!['page', 'pageSize'].includes(name) || url.searchParams.getAll(name).length !== 1) return json(res, 400, { code: 'CAPACITY_INVALID_QUERY' });
    const options = {};
    for (const [name, fallback, max] of [['page', 1, 100000], ['pageSize', 10, 20]]) {
      const raw = url.searchParams.get(name), value = raw === null ? fallback : Number(raw);
      if ((raw !== null && !/^[1-9]\d*$/.test(raw)) || !Number.isSafeInteger(value) || value > max) return json(res, 400, { code: 'CAPACITY_INVALID_QUERY' });
      options[name] = value;
    }
    const cancel = new AbortController(), timer = setTimeout(() => cancel.abort(), timeoutMs);
    let rejectCancelled;
    const cancellation = new Promise((_, reject) => {
      rejectCancelled = () => reject(Object.assign(new Error('Capacity request cancelled'), { status: 504 }));
      cancel.signal.addEventListener('abort', rejectCancelled, { once: true });
    });
    const abort = () => { if (!res.writableEnded) cancel.abort(); }; req.once('aborted', abort); res.once('close', abort);
    try {
      // Keep rejection handlers attached to late provider results, even after cancellation wins.
      const data = await Promise.race([
        cancellation,
        Promise.resolve().then(() => provider.getDeviceCapacityPage(match[1], match[2], { ...options, signal: cancel.signal })),
      ]);
      if (cancel.signal.aborted) return json(res, 504, { code: 'CAPACITY_TIMEOUT' });
      if (Buffer.byteLength(JSON.stringify(data)) > 262144) return json(res, 502, { code: 'CAPACITY_RESPONSE_LIMIT' });
      return json(res, 200, data);
    } catch (error) {
      const status = cancel.signal.aborted ? 504 : [400, 403, 404, 503, 504].includes(error?.status) ? error.status : 502;
      return json(res, status, { code: cancel.signal.aborted ? 'CAPACITY_TIMEOUT' : 'CAPACITY_READ_FAILED' });
    } finally { clearTimeout(timer); cancel.signal.removeEventListener('abort', rejectCancelled); req.removeListener('aborted', abort); res.removeListener('close', abort); }
  });
  server.headersTimeout = 5000; server.requestTimeout = 10000; server.maxConnections = 16;
  return server;
}
