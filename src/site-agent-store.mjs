import { createHash } from 'node:crypto';
import { AppError } from './contracts.mjs';

export class InMemorySiteAgentStore {
  constructor({ clock = () => Date.now(), receiptLimit = 1000, alertEventLimit = 1000 } = {}) {
    this.clock = clock;
    this.receiptLimit = receiptLimit;
    this.alertEventLimit = alertEventLimit;
    this.sources = new Map();
  }

  ingestAlertEvents(identity, batch) {
    const source = this.sources.get(identity.sourceId) || createSource(identity);
    assertSameIdentity(source, identity);
    const digest = batchDigest(batch);
    const previous = source.alertEventReceipts.get(batch.deliveryId);
    if (previous) {
      if (previous !== digest) throw new AppError(409, 'SITE_AGENT_ALERT_DELIVERY_CONFLICT', 'deliveryId was already used with different content');
      return alertEventResult(identity.sourceId, batch, true);
    }
    source.alertEvents.push(makeAlertDelivery(identity, batch, this.clock()));
    while (source.alertEvents.length > this.alertEventLimit) source.alertEvents.shift();
    source.alertEventReceipts.set(batch.deliveryId, digest);
    trimMap(source.alertEventReceipts, this.receiptLimit);
    this.sources.set(identity.sourceId, source);
    return alertEventResult(identity.sourceId, batch, false);
  }

  ingestAlertSnapshot(identity, batch) {
    const source = this.sources.get(identity.sourceId) || createSource(identity);
    assertSameIdentity(source, identity);
    const digest = batchDigest(batch);
    const previous = source.alertSnapshotReceipts.get(batch.snapshotId);
    if (previous) {
      if (previous.digest !== digest) throw new AppError(409, 'SITE_AGENT_ALERT_SNAPSHOT_CONFLICT', 'snapshotId was already used with different content');
      return alertSnapshotResult(identity.sourceId, batch, true, previous.applied, previous.outOfOrder);
    }
    if (source.alertSnapshot?.sequence === batch.sequence) throw new AppError(409, 'SITE_AGENT_ALERT_SEQUENCE_CONFLICT', 'alert snapshot sequence was already used');
    const outOfOrder = Boolean(source.alertSnapshot && batch.sequence < source.alertSnapshot.sequence);
    const applied = !outOfOrder;
    if (applied) source.alertSnapshot = makeAlertSnapshot(identity, batch, this.clock());
    source.alertSnapshotReceipts.set(batch.snapshotId, { digest, applied, outOfOrder });
    trimMap(source.alertSnapshotReceipts, this.receiptLimit);
    this.sources.set(identity.sourceId, source);
    return alertSnapshotResult(identity.sourceId, batch, false, applied, outOfOrder);
  }

  ingest(identity, batch) {
    const source = this.sources.get(identity.sourceId) || createSource(identity);
    assertSameIdentity(source, identity);
    const digest = createHash('sha256').update(JSON.stringify(batch)).digest('hex');
    const previous = source.receipts.get(batch.batchId);
    if (previous) {
      if (previous.digest !== digest) throw new AppError(409, 'SITE_AGENT_BATCH_CONFLICT', 'batchId was already used with different content');
      return result(identity.sourceId, batch, true, previous.applied, previous.outOfOrder);
    }
    if (source.snapshot?.sequence === batch.sequence) {
      throw new AppError(409, 'SITE_AGENT_SEQUENCE_CONFLICT', 'sequence was already used by another batch');
    }
    const outOfOrder = Boolean(source.snapshot && batch.sequence < source.snapshot.sequence);
    const applied = !outOfOrder;
    if (applied) source.snapshot = makeSnapshot(identity, batch, this.clock());
    source.receipts.set(batch.batchId, { digest, applied, outOfOrder });
    while (source.receipts.size > this.receiptLimit) source.receipts.delete(source.receipts.keys().next().value);
    this.sources.set(identity.sourceId, source);
    return result(identity.sourceId, batch, false, applied, outOfOrder);
  }

  listSources(tenantIds) {
    const allowed = new Set(tenantIds);
    return [...this.sources.values()]
      .filter((source) => source.snapshot && allowed.has(source.tenantId))
      .map((source) => summarize(source.snapshot, this.clock()))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  }

  snapshot(sourceId, tenantIds) {
    const source = this.sources.get(sourceId);
    if (!source?.snapshot || !new Set(tenantIds).has(source.tenantId)) {
      throw new AppError(404, 'SITE_AGENT_SOURCE_NOT_FOUND', 'Source was not found');
    }
    return { ...clone(source.snapshot), ...freshnessFields(source.snapshot.observedAt, this.clock()) };
  }

  listAlertEvents(sourceId, tenantIds, { limit = 100 } = {}) {
    const source = visibleSource(this.sources.get(sourceId), tenantIds);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return { sourceId, items: clone(source.alertEvents.slice(-safeLimit).reverse()) };
  }

  alertSnapshot(sourceId, tenantIds) {
    const source = visibleSource(this.sources.get(sourceId), tenantIds);
    if (!source.alertSnapshot) throw new AppError(404, 'SITE_AGENT_ALERT_SNAPSHOT_NOT_FOUND', 'Alert snapshot was not found');
    return { ...clone(source.alertSnapshot), ...freshnessFields(source.alertSnapshot.observedAt, this.clock()) };
  }
}

function createSource(identity) {
  return {
    ...identity, receipts: new Map(), snapshot: null,
    alertEventReceipts: new Map(), alertSnapshotReceipts: new Map(),
    alertEvents: [], alertSnapshot: null
  };
}

function visibleSource(source, tenantIds) {
  if (!source || !new Set(tenantIds).has(source.tenantId)) throw new AppError(404, 'SITE_AGENT_SOURCE_NOT_FOUND', 'Source was not found');
  return source;
}

function assertSameIdentity(source, identity) {
  if (source.tenantId !== identity.tenantId || source.siteId !== identity.siteId) {
    throw new AppError(409, 'SITE_AGENT_SOURCE_CONFLICT', 'sourceId is already bound to another identity');
  }
}

function makeSnapshot(identity, batch, now) {
  const sourceId = identity.sourceId;
  return {
    ...identity,
    schemaVersion: batch.schemaVersion,
    sequence: batch.sequence,
    observedAt: batch.observedAt,
    receivedAt: new Date(now).toISOString(),
    devices: batch.devices.map((device) => ({ ...device, deviceKey: `${sourceId}/device/${encodeURIComponent(device.localDeviceId)}` })),
    ports: batch.ports.map((port) => ({
      ...port,
      deviceKey: `${sourceId}/device/${encodeURIComponent(port.localDeviceId)}`,
      portKey: `${sourceId}/port/${encodeURIComponent(port.localPortId)}`
    }))
  };
}

function makeAlertDelivery(identity, batch, now) {
  return {
    ...identity, ...batch, receivedAt: new Date(now).toISOString(),
    alerts: globalAlerts(identity.sourceId, batch.alerts)
  };
}

function makeAlertSnapshot(identity, batch, now) {
  return {
    ...identity, ...batch, receivedAt: new Date(now).toISOString(),
    alerts: globalAlerts(identity.sourceId, batch.alerts)
  };
}

function globalAlerts(sourceId, alerts) {
  return alerts.map((alert) => ({ ...alert, alertKey: `${sourceId}/alert/${encodeURIComponent(alert.fingerprint)}` }));
}

function summarize(snapshot, now) {
  return {
    tenantId: snapshot.tenantId, siteId: snapshot.siteId, sourceId: snapshot.sourceId,
    sequence: snapshot.sequence, observedAt: snapshot.observedAt, receivedAt: snapshot.receivedAt,
    deviceCount: snapshot.devices.length, portCount: snapshot.ports.length,
    ...freshnessFields(snapshot.observedAt, now)
  };
}

function freshnessFields(observedAt, now) {
  const ageSeconds = Math.max(0, Math.floor((now - Date.parse(observedAt)) / 1000));
  const freshness = ageSeconds <= 90 ? 'fresh' : ageSeconds <= 300 ? 'delayed' : 'stale';
  return { freshness, ageSeconds, sourceStatus: freshness === 'stale' ? 'offline' : 'online' };
}

function result(sourceId, batch, duplicate, applied, outOfOrder) {
  return { accepted: true, duplicate, applied, outOfOrder, sourceId, batchId: batch.batchId, sequence: batch.sequence };
}

function alertEventResult(sourceId, batch, duplicate) {
  return { accepted: true, duplicate, sourceId, deliveryId: batch.deliveryId, alertCount: batch.alerts.length };
}

function alertSnapshotResult(sourceId, batch, duplicate, applied, outOfOrder) {
  return { accepted: true, duplicate, applied, outOfOrder, sourceId, snapshotId: batch.snapshotId, sequence: batch.sequence, alertCount: batch.alerts.length };
}

function batchDigest(batch) {
  return createHash('sha256').update(JSON.stringify(batch)).digest('hex');
}

function trimMap(map, limit) {
  while (map.size > limit) map.delete(map.keys().next().value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
