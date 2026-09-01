import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { AppError, publicError } from './contracts.mjs';

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

export function createApp({ service, siteAgentService = null, publicDir, packageRoot, logger = console }) {
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
        const siteAgentResponse = await handleSiteAgentApi(siteAgentService, req, url);
        if (siteAgentResponse) return sendJson(res, siteAgentResponse.status, siteAgentResponse.body);
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

async function handleSiteAgentApi(service, req, url) {
  const { pathname } = url;
  const ingestRoute = pathname === '/api/v1/site-agent/batches';
  const cloudRoute = pathname === '/api/v1/cloud/monitoring/sources' || /^\/api\/v1\/cloud\/monitoring\/sources\/[^/]+\/snapshot$/.test(pathname);
  if (!ingestRoute && !cloudRoute) return null;
  if (!service) throw new AppError(503, 'SITE_AGENT_NOT_CONFIGURED', 'Site agent ingestion is not configured');
  if (ingestRoute) {
    if (req.method !== 'POST') throw new AppError(405, 'SITE_AGENT_METHOD_NOT_ALLOWED', 'Only POST is supported');
    const result = service.ingest(req.headers.authorization, await readJson(req, 2 * 1024 * 1024));
    return { status: result.duplicate ? 200 : 202, body: result };
  }
  if (req.method !== 'GET') throw new AppError(405, 'SITE_AGENT_METHOD_NOT_ALLOWED', 'Only GET is supported');
  if (pathname === '/api/v1/cloud/monitoring/sources') {
    return { status: 200, body: service.listSources(req.headers.authorization) };
  }
  const match = pathname.match(/^\/api\/v1\/cloud\/monitoring\/sources\/([^/]+)\/snapshot$/);
  return { status: 200, body: service.snapshot(req.headers.authorization, decodePart(match[1])) };
}

async function readJson(req, maxBytes) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new AppError(415, 'SITE_AGENT_UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw new AppError(413, 'SITE_AGENT_BATCH_TOO_LARGE', 'Batch exceeds the maximum request size');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new AppError(413, 'SITE_AGENT_BATCH_TOO_LARGE', 'Batch exceeds the maximum request size');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError(400, 'SITE_AGENT_INVALID_JSON', 'Request body must contain valid JSON'); }
}

async function handleApi(service, res, url, requestId) {
  const { pathname, searchParams } = url;
  if (pathname === '/api/v1/monitoring/health') return sendJson(res, 200, await service.health());
  if (pathname === '/api/v1/monitoring/overview') return sendJson(res, 200, await service.overview());
  if (pathname === '/api/v1/monitoring/devices') return sendJson(res, 200, { items: await service.devices() });
  if (pathname === '/api/v1/monitoring/alerts') return sendJson(res, 200, { items: await service.alerts({ state: searchParams.get('state') || 'all', limit: searchParams.get('limit') || 50 }) });
  if (pathname === '/api/v1/monitoring/ports') {
    return sendJson(res, 200, await service.allPorts({
      status: searchParams.get('status') || 'all', page: searchParams.get('page') || 1,
      pageSize: searchParams.get('pageSize') || 50, sort: searchParams.get('sort') || 'traffic',
      order: searchParams.get('order') || 'desc'
    }));
  }
  if (pathname === '/api/v1/monitoring/ports/rankings') {
    return sendJson(res, 200, await service.portRankings({
      metric: searchParams.get('metric') || 'traffic', limit: searchParams.get('limit') || 20,
      status: searchParams.get('status') || 'all'
    }));
  }

  const resourceMatch = pathname.match(/^\/api\/v1\/monitoring\/devices\/([^/]+)\/resources$/);
  if (resourceMatch) return sendJson(res, 200, await service.deviceResources(decodePart(resourceMatch[1])));

  const sensorMatch = pathname.match(/^\/api\/v1\/monitoring\/devices\/([^/]+)\/resources\/([^/]+)\/sensors$/);
  if (sensorMatch) return sendJson(res, 200, { items: await service.deviceResourceSensors(decodePart(sensorMatch[1]), decodePart(sensorMatch[2]), { limit: searchParams.get('limit') || 40 }) });

  const resourceSeriesMatch = pathname.match(/^\/api\/v1\/monitoring\/devices\/([^/]+)\/resources\/([^/]+)\/series$/);
  if (resourceSeriesMatch) return sendJson(res, 200, await service.deviceResourceSeries(
    decodePart(resourceSeriesMatch[1]), decodePart(resourceSeriesMatch[2]), seriesOptions(searchParams)
  ));

  const portSeriesMatch = pathname.match(/^\/api\/v1\/monitoring\/devices\/([^/]+)\/ports\/([^/]+)\/series$/);
  if (portSeriesMatch) return sendJson(res, 200, await service.portHistorySeries(
    decodePart(portSeriesMatch[1]), decodePart(portSeriesMatch[2]), seriesOptions(searchParams)
  ));

  const deviceGraphMatch = pathname.match(/^\/api\/v1\/monitoring\/devices\/([^/]+)\/graphs\/(device|health)\/([^/]+)$/);
  if (deviceGraphMatch) {
    const graph = await service.deviceGraph(decodePart(deviceGraphMatch[1]), deviceGraphMatch[2], decodePart(deviceGraphMatch[3]), graphOptions(searchParams));
    return sendBinary(res, graph);
  }

  const portGraphMatch = pathname.match(/^\/api\/v1\/monitoring\/devices\/([^/]+)\/ports\/([^/]+)\/graphs\/([^/]+)$/);
  if (portGraphMatch) {
    const graph = await service.portGraph(decodePart(portGraphMatch[1]), decodePart(portGraphMatch[2]), decodePart(portGraphMatch[3]), graphOptions(searchParams));
    return sendBinary(res, graph);
  }

  const arpMatch = pathname.match(/^\/api\/v1\/monitoring\/devices\/([^/]+)\/ports\/([^/]+)\/arp$/);
  if (arpMatch) return sendJson(res, 200, await service.portArp(decodePart(arpMatch[1]), decodePart(arpMatch[2])));

  const eventsMatch = pathname.match(/^\/api\/v1\/monitoring\/devices\/([^/]+)\/events$/);
  if (eventsMatch) return sendJson(res, 200, await service.deviceEvents(decodePart(eventsMatch[1]), {
    from: searchParams.get('from') || undefined, to: searchParams.get('to') || undefined,
    limit: searchParams.get('limit') || 50
  }));

  const portMatch = pathname.match(/^\/api\/v1\/monitoring\/devices\/([^/]+)\/ports$/);
  if (portMatch) return sendJson(res, 200, { items: await service.ports(decodePart(portMatch[1])) });
  if (pathname === '/api/v1/monitoring/series/port-traffic') return sendJson(res, 200, await service.portTrafficSeries(searchParams.get('deviceId'), searchParams.get('portId')));
  return sendJson(res, 404, { code: 'MONITORING_ROUTE_NOT_FOUND', message: 'Route not found', requestId });
}

function graphOptions(searchParams) {
  return {
    from: searchParams.get('from') || '-24h', to: searchParams.get('to') || 'now',
    width: searchParams.get('width') || 1000, height: searchParams.get('height') || 280
  };
}

function seriesOptions(searchParams) {
  return {
    from: searchParams.get('from') || '-24h', to: searchParams.get('to') || 'now',
    maxPoints: searchParams.get('maxPoints') || 360
  };
}

function decodePart(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

async function handleStatic(req, res, publicDir, pathname, requestId) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return sendJson(res, 400, { code: 'MONITORING_INVALID_PATH', message: 'Invalid path encoding', requestId }); }
  const requested = decoded === '/' ? 'insights.html' : decoded.replace(/^\/+/, '');
  const root = resolve(publicDir);
  const file = resolve(root, requested);
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith(`..${sep}`)) return sendJson(res, 403, { code: 'MONITORING_FORBIDDEN', message: 'Forbidden', requestId });
  try { return await sendFile(req, res, file); }
  catch {
    if (extname(file)) return sendJson(res, 404, { code: 'MONITORING_ASSET_NOT_FOUND', message: 'Asset not found', requestId });
    return await sendFile(req, res, resolve(root, 'insights.html'));
  }
}

async function sendFile(req, res, file) {
  const body = await readFile(file);
  res.writeHead(200, { 'content-type': mimeTypes[extname(file)] || 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-store' : 'public, max-age=3600' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendBinary(res, graph) {
  res.writeHead(200, { 'content-type': graph.contentType, 'cache-control': 'private, max-age=30', 'content-length': graph.body.length });
  res.end(graph.body);
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
