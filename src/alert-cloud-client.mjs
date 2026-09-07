const endpoints = new Map([
  ['alert-events', '/api/v1/site-agent/alert-events'],
  ['alert-snapshot', '/api/v1/site-agent/alert-snapshots']
]);

export class AlertCloudDeliveryError extends Error {
  constructor(message, { status = null, retryable = true, code = 'ALERT_CLOUD_DELIVERY_FAILED', cause } = {}) {
    super(message, { cause });
    this.name = 'AlertCloudDeliveryError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

export class AlertCloudClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    this.baseUrl = cloudUrl(baseUrl);
    this.token = credential(token);
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('timeoutMs is invalid');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async upload(payload) {
    const path = endpoints.get(payload?.kind);
    if (!path) throw new AlertCloudDeliveryError('Alert payload kind is not supported', { retryable: false, code: 'ALERT_CLOUD_INVALID_KIND' });
    let response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (cause) {
      throw new AlertCloudDeliveryError('Cloud alert request failed before a response', {
        retryable: true, code: 'ALERT_CLOUD_NETWORK_ERROR', cause
      });
    }
    if (response.status >= 200 && response.status < 300) return { accepted: true, status: response.status };
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw new AlertCloudDeliveryError(`Cloud alert request failed with HTTP ${response.status}`, {
      status: response.status, retryable,
      code: retryable ? 'ALERT_CLOUD_TRANSIENT_RESPONSE' : 'ALERT_CLOUD_PERMANENT_RESPONSE'
    });
  }
}

function cloudUrl(value) {
  let url;
  try { url = new URL(String(value ?? '')); }
  catch { throw new TypeError('Cloud URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('Cloud URL must be an HTTP(S) origin without credentials, path, query or fragment');
  }
  if (url.protocol === 'http:' && !loopbackHost(url.hostname)) {
    throw new TypeError('Cloud URL must use HTTPS unless it targets the local loopback interface');
  }
  return url;
}

function loopbackHost(hostname) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname.toLowerCase());
}

function credential(value) {
  const token = String(value ?? '');
  if (token.length < 16 || token.length > 4096 || /[\u0000-\u0020\u007f]/u.test(token)) throw new TypeError('Cloud credential is invalid');
  return token;
}
