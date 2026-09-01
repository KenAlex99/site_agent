import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { publicError } from './contracts.mjs';

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

export function createApp({ service, publicDir, packageRoot, logger = console }) {
  const assets = new Map([
    ['/vendor/chart.umd.js', resolve(packageRoot, 'node_modules/chart.js/dist/chart.umd.js')],
    ['/vendor/uPlot.iife.min.js', resolve(packageRoot, 'node_modules/uplot/dist/uPlot.iife.min.js')],
    ['/vendor/uPlot.min.css', resolve(packageRoot, 'node_modules/uplot/dist/uPlot.min.css')]
  ]);
  return async function app(req, res) {
    const requestId = safeRequestId(req.headers['x-request-id']);
    setSecurityHeaders(res, requestId);
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') return sendJson(res, 405, { code: 'MONITORING_METHOD_NOT_ALLOWED', message: 'Only GET is supported', requestId });
        return await handleApi(service, res, url, requestId);
      }
      if (!['GET', 'HEAD'].includes(req.method || 'GET')) return sendJson(res, 405, { code: 'MONITORING_METHOD_NOT_ALLOWED', message: 'Method not allowed', requestId });
      const vendorFile = assets.get(url.pathname);
      if (vendorFile) return await sendFile(req, res, vendorFile);
      return await handleStatic(req, res, publicDir, url.pathname, requestId);
    } catch (error) {
      const response = publicError(error, requestId);
      logger.warn?.({ requestId, code: error?.code, message: error?.message }, 'monitoring request failed');
      return sendJson(res, response.status, response.body);
    }
  };
}

async function handleApi(service, res, url, requestId) {
  const { pathname, searchParams } = url;
  if (pathname === '/api/v1/monitoring/health') return sendJson(res, 200, await service.health());
  if (pathname === '/api/v1/monitoring/overview') return sendJson(res, 200, await service.overview());
  if (pathname === '/api/v1/monitoring/devices') return sendJson(res, 200, { items: await service.devices() });
  if (pathname === '/api/v1/monitoring/alerts') return sendJson(res, 200, { items: await service.alerts({ state: searchParams.get('state') || 'all', limit: searchParams.get('limit') || 50 }) });
  const portMatch = pathname.match(/^\/api\/v1\/monitoring\/devices\/([^/]+)\/ports$/);
  if (portMatch) return sendJson(res, 200, { items: await service.ports(decodeURIComponent(portMatch[1])) });
  if (pathname === '/api/v1/monitoring/series/port-traffic') return sendJson(res, 200, await service.portTrafficSeries(searchParams.get('deviceId'), searchParams.get('portId')));
  return sendJson(res, 404, { code: 'MONITORING_ROUTE_NOT_FOUND', message: 'Route not found', requestId });
}

async function handleStatic(req, res, publicDir, pathname, requestId) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return sendJson(res, 400, { code: 'MONITORING_INVALID_PATH', message: 'Invalid path encoding', requestId }); }
  const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const root = resolve(publicDir);
  const file = resolve(root, requested);
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith(`..${sep}`)) return sendJson(res, 403, { code: 'MONITORING_FORBIDDEN', message: 'Forbidden', requestId });
  try { return await sendFile(req, res, file); }
  catch {
    if (extname(file)) return sendJson(res, 404, { code: 'MONITORING_ASSET_NOT_FOUND', message: 'Asset not found', requestId });
    return await sendFile(req, res, resolve(root, 'index.html'));
  }
}

async function sendFile(req, res, file) {
  const body = await readFile(file);
  res.writeHead(200, { 'content-type': mimeTypes[extname(file)] || 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-store' : 'public, max-age=3600' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function safeRequestId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(id) ? id : randomUUID();
}

function setSecurityHeaders(res, requestId) {
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}
