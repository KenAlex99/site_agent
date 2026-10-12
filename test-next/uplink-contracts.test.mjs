import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeUplinkEnvelope } from '../src/uplink-contracts.mjs';

const edgeId = 'center-issued-edge-opaque-01';
const assetId = 'asst_01J4Z3K8X9Y2M4N6P7Q8R0T2V4';

test('normalizes a confirmed-asset envelope as a detached JSON value', () => {
  const input = envelope({ asset_id: assetId });
  const result = normalizeUplinkEnvelope(input, { edgeId });

  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result.payload, input.payload);
  input.payload.status = 'resolved';
  assert.equal(result.payload.status, 'firing');
});

test('accepts a complete source identity without turning it into an asset', () => {
  const input = envelope({
    source_identity: {
      edge_id: edgeId,
      system: 'librenms',
      object_type: 'device',
      identifier_kind: 'librenms_device_id',
      external_id: '42'
    }
  });

  const result = normalizeUplinkEnvelope(input, { edgeId });
  assert.deepEqual(result.source_identity, input.source_identity);
  assert.equal('asset_id' in result, false);
});

test('rejects missing or mismatched Edge identity without echoing values', () => {
  invalid(envelope({ asset_id: assetId }), {}, 'configured edge identity');
  invalid({ ...envelope({ asset_id: assetId }), edge_id: 'other-edge' }, { edgeId }, 'edge_id');
  invalid(envelope({ source_identity: {
    edge_id: 'other-edge', system: 'librenms', object_type: 'device',
    identifier_kind: 'librenms_device_id', external_id: '42'
  } }), { edgeId }, 'source_identity.edge_id');
});

test('requires a confirmed asset or a complete registered source identity', () => {
  invalid(envelope(), { edgeId }, 'asset_id or source_identity');
  invalid(envelope({ asset_id: 'device-42' }), { edgeId }, 'asset_id');
  invalid(envelope({ source_identity: {
    edge_id: edgeId, system: 'unknown', object_type: 'device',
    identifier_kind: 'librenms_device_id', external_id: '42'
  } }), { edgeId }, 'source_identity.system');
  invalid(envelope({ source_identity: {
    edge_id: edgeId, system: 'librenms', object_type: 'router',
    identifier_kind: 'librenms_device_id', external_id: '42'
  } }), { edgeId }, 'source_identity.object_type');
  invalid(envelope({ source_identity: {
    edge_id: edgeId, system: 'librenms', object_type: 'device',
    identifier_kind: 'unknown', external_id: '42'
  } }), { edgeId }, 'source_identity.identifier_kind');
});

test('rejects metrics, commands, unknown types and command control fields', () => {
  for (const type of ['metric', 'command', 'unknown']) {
    invalid({ ...envelope({ asset_id: assetId }), type }, { edgeId }, 'type');
  }
  invalid({ ...envelope({ asset_id: assetId }), command: { kind: 'restart' } }, { edgeId }, 'command');
});

test('rejects unknown envelope and source identity fields', () => {
  invalid({ ...envelope({ asset_id: assetId }), tenant_id: 'tenant-a' }, { edgeId }, 'tenant_id');
  invalid(envelope({ source_identity: {
    edge_id: edgeId, system: 'librenms', object_type: 'device',
    identifier_kind: 'librenms_device_id', external_id: '42', site_name: 'site-a'
  } }), { edgeId }, 'source_identity.site_name');
});

test('requires an exact UTC millisecond timestamp and bounded idempotency key', () => {
  invalid({ ...envelope({ asset_id: assetId }), ts: '2026-10-12T03:18:25Z' }, { edgeId }, 'ts');
  invalid({ ...envelope({ asset_id: assetId }), ts: '2026-10-12T11:18:25.123+08:00' }, { edgeId }, 'ts');
  invalid({ ...envelope({ asset_id: assetId }), ts: '2026-02-30T03:18:25.123Z' }, { edgeId }, 'ts');
  invalid({ ...envelope({ asset_id: assetId }), idempotency_key: '1234567' }, { edgeId }, 'idempotency_key');
  invalid({ ...envelope({ asset_id: assetId }), idempotency_key: 'x'.repeat(129) }, { edgeId }, 'idempotency_key');
});

test('requires a plain JSON payload and rejects oversized envelopes', () => {
  invalid({ ...envelope({ asset_id: assetId }), payload: [] }, { edgeId }, 'payload');
  invalid({ ...envelope({ asset_id: assetId }), payload: new Date() }, { edgeId }, 'payload');
  invalid({ ...envelope({ asset_id: assetId }), payload: { value: undefined } }, { edgeId }, 'payload');

  const circular = {};
  circular.self = circular;
  invalid({ ...envelope({ asset_id: assetId }), payload: circular }, { edgeId }, 'payload');

  invalid({
    ...envelope({ asset_id: assetId }),
    payload: { text: 'x'.repeat(256 * 1024) }
  }, { edgeId }, '256 KiB');
});

test('keeps both Uplink foundation modules in the project syntax gate', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts.check, /node --check src\/uplink-config\.mjs/);
  assert.match(packageJson.scripts.check, /node --check src\/uplink-contracts\.mjs/);
});

function envelope(extra = {}) {
  return {
    module: 'monitoring',
    edge_id: edgeId,
    ts: '2026-10-12T03:18:25.123Z',
    type: 'alert',
    payload: { fingerprint: 'alert-example-42', status: 'firing' },
    idempotency_key: 'librenms:981:firing:20261012T031825123Z',
    ...extra
  };
}

function invalid(input, options, field) {
  assert.throws(() => normalizeUplinkEnvelope(input, options), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'UPLINK_INVALID_ENVELOPE');
    assert.match(error.message, new RegExp(field.replaceAll('.', '\\.'), 'i'));
    assert.equal(error.message.includes('other-edge'), false);
    return true;
  });
}
