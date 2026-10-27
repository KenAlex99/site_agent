import { randomUUID } from 'node:crypto';

export async function enrollSiteAgent({ client, store, enrollmentCode, centerOrigin, now = () => new Date() } = {}) {
  if (!client || typeof client.request !== 'function' || !store
    || typeof store.load !== 'function' || typeof store.beginAttempt !== 'function' || typeof store.save !== 'function'
    || typeof enrollmentCode !== 'string' || enrollmentCode.length < 32 || enrollmentCode.length > 512
    || /[\u0000-\u001f\u007f]/u.test(enrollmentCode)
    || typeof centerOrigin !== 'string') {
    throw new Error('Enrollment configuration is invalid');
  }
  if (await store.load()) throw new Error('An identity is already enrolled');
  const attemptId = randomUUID();
  await store.beginAttempt(attemptId, now().toISOString());
  const response = await client.request({
    endpoint: 'enrollment',
    body: { enrollment_code: enrollmentCode, enrollment_attempt_id: attemptId }
  });
  if (response.status !== 201) throw new Error('Enrollment was not accepted; operator recovery is required');
  const result = response.body;
  if (!validResult(result)) throw new Error('Enrollment response was invalid; operator recovery is required');
  return store.save({ format_version: 1, center_origin: centerOrigin, enrollment_attempt_id: attemptId, ...result });
}

function validResult(value) {
  const expected = ['edge_id', 'issued_at', 'scopes', 'uplink_credential'];
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join('|') === expected.join('|')
    && /^edge_[A-Za-z0-9_-]{22,120}$/u.test(value.edge_id || '')
    && typeof value.uplink_credential === 'string'
    && value.uplink_credential.length >= 32 && value.uplink_credential.length <= 512
    && !/[\u0000-\u0020\u007f]/u.test(value.uplink_credential)
    && Array.isArray(value.scopes) && value.scopes.length === 1 && value.scopes[0] === 'ingest'
    && typeof value.issued_at === 'string' && value.issued_at.endsWith('Z')
    && Number.isFinite(Date.parse(value.issued_at));
}

