import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const deployment = resolve(root, 'deploy/examples/alertmanager');

test('keeps Alertmanager deployment optional, persistent, pinned and loopback-managed', async () => {
  const compose = await readFile(resolve(deployment, 'compose.yaml'), 'utf8');
  assert.match(compose, /profiles:\s*\[alerts\]/);
  assert.match(compose, /quay\.io\/prometheus\/alertmanager:v0\.33\.1/);
  assert.doesNotMatch(compose, /:latest\b/);
  assert.match(compose, /alertmanager-data:\/alertmanager/);
  assert.match(compose, /alert-relay-data:\/var\/lib\/aiops-alert-relay/);
  assert.match(compose, /127\.0\.0\.1:\$\{ALERTMANAGER_PORT:-9093\}:9093/);
  assert.match(compose, /127\.0\.0\.1:\$\{ALERT_RELAY_PORT:-4312\}:4312/);
  assert.doesNotMatch(compose, /172\.21\.|192\.168\.|Bearer\s+[A-Za-z0-9]/);
});

test('configures resolved Webhooks with a credential file and local inhibition', async () => {
  const config = await readFile(resolve(deployment, 'alertmanager.yml'), 'utf8');
  assert.match(config, /send_resolved:\s*true/);
  assert.match(config, /credentials_file:\s*\/run\/secrets\/alertmanager_webhook_token/);
  assert.match(config, /inhibit_rules:/);
  assert.doesNotMatch(config, /credentials:\s*[^\s<]/);
});

test('documents native LibreNMS transport, validation, backup and rollback', async () => {
  const readme = await readFile(resolve(deployment, 'README.md'), 'utf8');
  assert.match(readme.toLowerCase(), /alertmanager\s+transport/);
  assert.match(readme.toLowerCase(), /docker\s+compose[^\n]*config/);
  for (const expected of ['--profile alerts', 'backup', 'rollback']) {
    assert.match(readme.toLowerCase(), new RegExp(expected.toLowerCase().replaceAll(' ', '\\s+')));
  }
});
