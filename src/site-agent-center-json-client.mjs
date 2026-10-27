import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { siteAgentCenterEndpoint } from './site-agent-center-target.mjs';

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class SiteAgentCenterRequestError extends Error {
  constructor(code, status = undefined) {
    super('Center request could not be safely completed');
    this.name = 'SiteAgentCenterRequestError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export function createSiteAgentCenterJsonClient({ target, timeoutMs = 10_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new TypeError('Center timeout is invalid');
  }
  return Object.freeze({
    request({ endpoint, body, bearerToken } = {}) {
      return sendCenterJsonRequest({ target, endpoint, body, bearerToken, timeoutMs });
    }
  });
}

function sendCenterJsonRequest({ target, endpoint, body, bearerToken, timeoutMs }) {
  const url = siteAgentCenterEndpoint(target, endpoint);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new TypeError('Center JSON body must be an object');
  }
  if (endpoint === 'enrollment' && bearerToken !== undefined) {
    throw new TypeError('Enrollment requests do not accept a bearer credential');
  }
  if (endpoint === 'ingest' && !validCredential(bearerToken)) {
    throw new TypeError('Center ingest credential is required');
  }

  let bytes;
  try { bytes = Buffer.from(JSON.stringify(body), 'utf8'); }
  catch { throw new TypeError('Center JSON body is invalid'); }
  if (bytes.length === 0 || bytes.length > MAX_REQUEST_BYTES) {
    throw new SiteAgentCenterRequestError('CENTER_REQUEST_SIZE');
  }

  const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let deadline;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        request?.destroy();
        reject(error);
      } else resolve(result);
    };

    try {
      const headers = {
        accept: 'application/json',
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'content-length': String(bytes.length),
        connection: 'close'
      };
      if (endpoint === 'ingest') headers.authorization = `Bearer ${bearerToken}`;
      request = requestImpl(url, { method: 'POST', headers, agent: false }, (response) => {
        response.on('error', () => finish(new SiteAgentCenterRequestError('CENTER_RESPONSE_INVALID')));
        const status = response.statusCode;
        if (!Number.isInteger(status) || status < 100 || status > 599 || (status >= 300 && status < 400)) {
          response.destroy();
          finish(new SiteAgentCenterRequestError('CENTER_STATUS_INVALID'));
          return;
        }
        if (response.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json'
          || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.destroy();
          finish(new SiteAgentCenterRequestError('CENTER_RESPONSE_INVALID', status));
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) finish(new SiteAgentCenterRequestError('CENTER_RESPONSE_SIZE', status));
          else if (!settled) chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
            finish(null, Object.freeze({ status, body: parsed }));
          } catch { finish(new SiteAgentCenterRequestError('CENTER_RESPONSE_INVALID', status)); }
        });
      });
      request.on('error', () => finish(new SiteAgentCenterRequestError('CENTER_TRANSPORT')));
      deadline = setTimeout(() => finish(new SiteAgentCenterRequestError('CENTER_TIMEOUT')), timeoutMs);
      request.end(bytes);
    } catch {
      finish(new SiteAgentCenterRequestError('CENTER_TRANSPORT'));
    }
  });
}

function validCredential(value) {
  return typeof value === 'string' && value.length >= 16 && value.length <= 4096
    && !/[\u0000-\u0020\u007f]/u.test(value);
}

