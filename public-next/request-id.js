let fallbackCounter = 0;

export function createRequestId({
  cryptoApi = globalThis.crypto,
  now = Date.now,
  random = Math.random
} = {}) {
  if (typeof cryptoApi?.randomUUID === 'function') {
    try { return cryptoApi.randomUUID(); } catch { /* insecure browser context: use the next fallback */ }
  }

  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  fallbackCounter = (fallbackCounter + 1) % Number.MAX_SAFE_INTEGER;
  const timestamp = Math.max(0, Number(now()) || 0).toString(36);
  const entropy = Math.floor(Math.max(0, Math.min(0.9999999999999999, Number(random()) || 0)) * 0x100000000).toString(36);
  return `web-${timestamp}-${fallbackCounter.toString(36)}-${entropy}`;
}
