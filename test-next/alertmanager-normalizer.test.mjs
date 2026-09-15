import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAlertmanagerWebhook,
  normalizeAlertmanagerActiveAlerts
} from '../src/alertmanager-normalizer.mjs';

const observedAt = '2026-09-04T08:00:00Z';

function webhookAlert(overrides = {}) {
  return {
    status: 'firing',
    labels: {
      alertname: 'PortTrafficHigh', severity: 'page', instance: 'edge-01',
      device_id: '5', port_id: '27', ignored_vendor_label: 'not-forwarded'
    },
    annotations: {
      summary: 'Port traffic is above threshold', description: 'xe-0/0/1 is busy',
      runbook_url: 'https://runbooks.example/port-traffic', ignored_note: 'not-forwarded'
    },
    startsAt: '2026-09-04T07:55:00Z', endsAt: '0001-01-01T00:00:00Z',
    generatorURL: 'http://librenms/alert/42', fingerprint: 'a1b2c3d4',
    ...overrides
  };
}

function webhook(overrides = {}) {
  return {
    version: '4', groupKey: '{}:{alertname="PortTrafficHigh"}', truncatedAlerts: 0,
    status: 'firing', receiver: 'site-agent-relay', groupLabels: {}, commonLabels: {},
    commonAnnotations: {}, externalURL: 'http://alertmanager:9093', alerts: [webhookAlert()],
    ...overrides
  };
}

function apiAlert(overrides = {}) {
  return {
    annotations: { summary: 'Device is unreachable' },
    endsAt: '0001-01-01T00:00:00Z', fingerprint: 'ffeedd11',
    receivers: [{ name: 'site-agent-relay' }], startsAt: '2026-09-04T07:58:00Z',
    status: { inhibitedBy: [], silencedBy: [], state: 'active' },
    updatedAt: '2026-09-04T07:59:00Z', generatorURL: '',
    labels: { alertname: 'DeviceDown', severity: 'warn', site: 'hk-a' },
    ...overrides
  };
}

test('normalizes official Alertmanager Webhook firing and resolved deliveries', () => {
  const firing = normalizeAlertmanagerWebhook(webhook(), { observedAt, deliveryId: 'delivery-01' });
  assert.equal(firing.schemaVersion, '1.0');
  assert.equal(firing.kind, 'alert-events');
  assert.equal(firing.status, 'firing');
  assert.equal(firing.alerts[0].status, 'firing');
  assert.equal(firing.alerts[0].labels.severity, 'critical');
  assert.equal(firing.alerts[0].labels.ignored_vendor_label, undefined);
  assert.equal(firing.alerts[0].annotations.ignored_note, undefined);
  assert.equal(firing.alerts[0].endsAt, undefined);

  const resolved = normalizeAlertmanagerWebhook(webhook({
    status: 'resolved',
    alerts: [webhookAlert({ status: 'resolved', endsAt: '2026-09-04T07:59:30Z' })]
  }), { observedAt, deliveryId: 'delivery-02' });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.alerts[0].status, 'resolved');
  assert.equal(resolved.alerts[0].endsAt, '2026-09-04T07:59:30.000Z');
});

test('normalizes API v2 active, silenced and inhibited alerts into a complete snapshot', () => {
  const normalized = normalizeAlertmanagerActiveAlerts([
    apiAlert(),
    apiAlert({
      fingerprint: 'silenced-01',
      labels: { alertname: 'Maintenance', severity: 'informational' },
      status: { state: 'suppressed', silencedBy: ['silence-a'], inhibitedBy: [] }
    }),
    apiAlert({
      fingerprint: 'inhibited-01',
      labels: { alertname: 'PortDown', severity: 'something-new' },
      status: { state: 'suppressed', silencedBy: [], inhibitedBy: ['device-down'] }
    })
  ], { observedAt, snapshotId: 'snapshot-01', sequence: 12 });

  assert.equal(normalized.kind, 'alert-snapshot');
  assert.equal(normalized.sequence, 12);
  assert.deepEqual(normalized.alerts.map((item) => item.status), ['firing', 'suppressed', 'suppressed']);
  assert.deepEqual(normalized.alerts.map((item) => item.labels.severity), ['warning', 'info', 'unknown']);
});

test('requires fingerprints, statuses and RFC3339 timestamps', () => {
  assert.throws(
    () => normalizeAlertmanagerWebhook(webhook({ alerts: [webhookAlert({ fingerprint: '' })] }), { observedAt, deliveryId: 'delivery-03' }),
    /fingerprint/
  );
  assert.throws(
    () => normalizeAlertmanagerWebhook(webhook({ alerts: [webhookAlert({ status: 'pending' })] }), { observedAt, deliveryId: 'delivery-03' }),
    /status/
  );
  assert.throws(
    () => normalizeAlertmanagerActiveAlerts([apiAlert({ startsAt: 'yesterday' })], { observedAt, snapshotId: 'snapshot-02', sequence: 13 }),
    /startsAt/
  );
});

test('rejects sensitive keys, control characters and excessive payload maps', () => {
  assert.throws(
    () => normalizeAlertmanagerWebhook(webhook({ alerts: [webhookAlert({ labels: { alertname: 'Leak', api_token: 'secret' } })] }), { observedAt, deliveryId: 'delivery-04' }),
    /sensitive/
  );
  assert.throws(
    () => normalizeAlertmanagerWebhook(webhook({ alerts: [webhookAlert({ annotations: { summary: 'bad\u0000text' } })] }), { observedAt, deliveryId: 'delivery-05' }),
    /control/
  );
  const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`label_${index}`, 'x']));
  assert.throws(
    () => normalizeAlertmanagerWebhook(webhook({ alerts: [webhookAlert({ labels: { alertname: 'TooMany', ...tooMany } })] }), { observedAt, deliveryId: 'delivery-06' }),
    /at most 64/
  );
});
