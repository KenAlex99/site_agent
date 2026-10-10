import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAttributeFields, projectDeviceAttributes } from '../src/device-attributes.mjs';

test('projects safe scalar attributes with stable typed paths', () => {
  const result = projectDeviceAttributes({
    hostname: 'edge.example', status: 1, disabled: false, location: { name: '机房 A', latitude: 22.3 }, tags: ['core', 'wan'], nullable: null
  });

  assert.deepEqual(result.items.map(({ key, type, value }) => ({ key, type, value })), [
    { key: 'disabled', type: 'boolean', value: false },
    { key: 'hostname', type: 'string', value: 'edge.example' },
    { key: 'location.latitude', type: 'number', value: 22.3 },
    { key: 'location.name', type: 'string', value: '机房 A' },
    { key: 'nullable', type: 'null', value: null },
    { key: 'status', type: 'number', value: 1 },
    { key: 'tags[0]', type: 'string', value: 'core' },
    { key: 'tags[1]', type: 'string', value: 'wan' }
  ]);
  assert.equal(result.truncated, false);
});

test('removes credentials and notes at every nesting level before output', () => {
  const result = projectDeviceAttributes({
    hostname: 'edge-1', community: 'private', authalgo: 'SHA', notes: 'contains operational secret',
    snmp: { version: 'v3', auth_password: 'secret-a', privKey: 'secret-b' },
    nested: { api_token: 'secret-c', model: 'safe-model' },
    constructor: { prototype: 'pollution' }
  });
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.items.map((item) => item.key), ['hostname', 'nested.model', 'snmp.version']);
  assert.doesNotMatch(serialized, /private|secret-a|secret-b|secret-c|operational secret|pollution/);
});

test('supports exact field narrowing without allowing sensitive fields back in', () => {
  const fields = parseAttributeFields('hostname,location.name,community');
  const result = projectDeviceAttributes({ hostname: 'edge-1', location: { name: 'DC-1', id: 9 }, community: 'private' }, { fields });
  assert.deepEqual(result.items.map((item) => item.key), ['hostname', 'location.name']);
  assert.equal(result.requestedFields, 3);
  assert.equal(result.truncated, false);
});

test('bounds field queries, nesting, values and total items', () => {
  assert.throws(() => parseAttributeFields('bad field'), { code: 'MONITORING_INVALID_ARGUMENT' });
  assert.throws(() => parseAttributeFields(Array.from({ length: 101 }, (_, index) => `f${index}`).join(',')), { code: 'MONITORING_INVALID_ARGUMENT' });
  const result = projectDeviceAttributes({ a: 'x'.repeat(5000), b: 2, deep: { one: { two: { three: { four: { five: 'hidden' } } } } } }, { maxItems: 2, maxStringLength: 32 });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].value.length, 32);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /hidden/);
});
