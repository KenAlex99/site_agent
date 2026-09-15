import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const contractUrl = new URL('../contracts/openapi.yaml', import.meta.url);

test('documents concrete schemas for core monitoring responses', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  assert.match(contract, /version: 1\.3\.0/);

  const expectedSchemas = [
    'MonitoringHealth',
    'MonitoringOverview',
    'MonitoringDeviceList',
    'MonitoringPortList',
    'MonitoringAlertList',
    'MonitoringPortPage',
    'MonitoringPortRankingPage'
  ];

  for (const schema of expectedSchemas) {
    assert.match(contract, new RegExp(`schema: \\{ \\$ref: '#/components/schemas/${schema}' \\}`));
    assert.match(contract, new RegExp(`^    ${schema}:`, 'm'));
  }
});

test('documents stable ID sorting for full port collection', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  const start = contract.indexOf('  /api/v1/monitoring/ports:');
  const end = contract.indexOf('  /api/v1/monitoring/ports/rankings:', start);
  assert.ok(start >= 0 && end > start);
  assert.match(contract.slice(start, end), /enum: \[id, traffic, utilization, errors, discards\]/);
});
