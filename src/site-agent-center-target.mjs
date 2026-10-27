const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

const centerPaths = Object.freeze({
  enrollment: '/api/v1/edge/enroll',
  ingest: '/ingest'
});

export function loadSiteAgentCenterTarget(env = process.env) {
  const value = env.SITE_AGENT_CENTER_ORIGIN;
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new TypeError('SITE_AGENT_CENTER_ORIGIN must be a valid HTTPS origin');
  }

  let url;
  try { url = new URL(value); }
  catch { throw new TypeError('SITE_AGENT_CENTER_ORIGIN must be a valid HTTPS origin'); }

  const isLocalHttp = url.protocol === 'http:' && localHosts.has(url.hostname);
  if (
    (url.protocol !== 'https:' && !isLocalHttp)
    || url.username !== ''
    || url.password !== ''
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new TypeError('SITE_AGENT_CENTER_ORIGIN must be a valid HTTPS origin');
  }

  return Object.freeze({ origin: url.origin });
}

export function siteAgentCenterEndpoint(target, name) {
  if (!target || Object.getPrototypeOf(target) !== Object.prototype
    || Object.keys(target).length !== 1 || typeof target.origin !== 'string'
    || !Object.hasOwn(centerPaths, name)) {
    throw new TypeError('Center endpoint configuration is invalid');
  }

  let origin;
  try { origin = new URL(target.origin); }
  catch { throw new TypeError('Center endpoint configuration is invalid'); }
  if (origin.origin !== target.origin || origin.pathname !== '/' || origin.search || origin.hash
    || origin.username || origin.password
    || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && localHosts.has(origin.hostname)))) {
    throw new TypeError('Center endpoint configuration is invalid');
  }

  return new URL(centerPaths[name], origin);
}
