import { request as httpRequest } from 'node:http';
import { normalizeUplinkEnvelope } from './uplink-contracts.mjs';

const RESPONSE_LIMIT = 4096;
const endpointPattern = /^http:\/\/(127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/ingest$/u;
// One JSON member prevents duplicate-key acknowledgements from being accepted.
const ackPattern = /^\s*\{\s*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\s*:\s*(true|false)\s*\}\s*$/u;

function failure(code, httpStatus) {
  const error = new Error('Local Uplink delivery was not confirmed');
  error.name = 'LocalUplinkError';
  error.code = code;
  if (httpStatus !== undefined) error.httpStatus = httpStatus;
  return error;
}

export function prepareLocalUplinkDelivery(envelope, options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
    || Reflect.ownKeys(options).some((key) => !['edgeId', 'receiverUrl', 'timeoutMs'].includes(key))) {
    throw failure('UPLINK_LOCAL_CONFIG');
  }
  const { edgeId, receiverUrl = 'http://127.0.0.1:9099/ingest', timeoutMs = 10_000 } = options;
  const match = typeof receiverUrl === 'string' && endpointPattern.exec(receiverUrl);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw failure('UPLINK_LOCAL_CONFIG');
  }
  let bytes;
  try {
    bytes = Buffer.from(JSON.stringify(normalizeUplinkEnvelope(envelope, { edgeId })), 'utf8');
  } catch {
    throw failure('UPLINK_INVALID_ENVELOPE');
  }
  const hostname = match[1] === '[::1]' ? '::1' : '127.0.0.1';
  const port = Number(match[2]);
  return Object.freeze({
    send() {
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
          // Native HTTP, numeric host and fixed path: no DNS, environment proxy,
          // redirect following, credential header or caller-supplied transport.
          request = httpRequest({
            hostname, port, method: 'POST', path: '/ingest', agent: false,
            headers: { 'content-type': 'application/json', 'content-length': bytes.length }
          }, (response) => {
            response.on('error', () => finish(failure('UPLINK_LOCAL_TRANSPORT')));
            if (response.statusCode !== 200) {
              finish(failure('UPLINK_LOCAL_REJECTED', response.statusCode));
              return;
            }
            if (response.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json'
              || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
              finish(failure('UPLINK_LOCAL_ACK_INVALID'));
              return;
            }
            let size = 0;
            const chunks = [];
            response.on('data', (chunk) => {
              size += chunk.length;
              if (size > RESPONSE_LIMIT) finish(failure('UPLINK_LOCAL_ACK_INVALID'));
              else if (!settled) chunks.push(chunk);
            });
            response.on('end', () => {
              if (settled) return;
              try {
                const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
                const ack = ackPattern.exec(text);
                if (!ack || JSON.parse(ack[1]) !== 'deduplicated') throw new Error();
                finish(null, { acceptedLocally: true, deduplicated: ack[2] === 'true' });
              } catch { finish(failure('UPLINK_LOCAL_ACK_INVALID')); }
            });
          });
          request.on('error', () => finish(failure('UPLINK_LOCAL_TRANSPORT')));
          deadline = setTimeout(() => finish(failure('UPLINK_LOCAL_TIMEOUT')), timeoutMs);
          request.end(bytes);
        } catch { finish(failure('UPLINK_LOCAL_TRANSPORT')); }
      });
    }
  });
}

