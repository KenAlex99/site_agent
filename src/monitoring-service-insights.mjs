import { AppError, requireIdentifier } from './contracts.mjs';
import { MonitoringService as BaseMonitoringService } from './monitoring-service.mjs';

const rankingMetrics = new Set(['traffic', 'utilization', 'errors', 'discards']);
const portSorts = new Set(['id', ...rankingMetrics]);

export class MonitoringService extends BaseMonitoringService {
  async allPorts({ status = 'all', page = 1, pageSize = 50, sort = 'traffic', order = 'desc' } = {}) {
    const [ports, devices] = await Promise.all([this.provider.listAllPorts(), this.provider.listDevices()]);
    const deviceNames = new Map(devices.map((device) => [device.id, device.name]));
    const enriched = ports.map((port) => enrichPort(port, deviceNames.get(port.deviceId)));
    const filtered = status === 'all' ? enriched : enriched.filter((port) => port.status === status);
    const metric = portSorts.has(sort) ? sort : 'traffic';
    const direction = order === 'asc' ? 1 : -1;
    filtered.sort((left, right) => {
      const primary = metric === 'id'
        ? compareIdentifiers(left.id, right.id)
        : metricValue(left, metric) - metricValue(right, metric);
      return direction * primary || compareIdentifiers(left.id, right.id);
    });
    const safePage = boundedInteger(page, 1, 100000, 1);
    const safePageSize = boundedInteger(pageSize, 1, 200, 50);
    const start = (safePage - 1) * safePageSize;
    return {
      generatedAt: new Date(this.clock()).toISOString(),
      total: filtered.length,
      page: safePage,
      pageSize: safePageSize,
      items: filtered.slice(start, start + safePageSize)
    };
  }

  async portRankings({ metric = 'traffic', limit = 20, status = 'all' } = {}) {
    if (!rankingMetrics.has(metric)) throw new AppError(400, 'MONITORING_INVALID_ARGUMENT', 'ranking metric is invalid');
    const result = await this.allPorts({ status, page: 1, pageSize: boundedInteger(limit, 1, 100, 20), sort: metric, order: 'desc' });
    return {
      generatedAt: result.generatedAt,
      metric,
      total: result.total,
      items: result.items.map((item, index) => ({ ...item, rank: index + 1, rankingValue: metricValue(item, metric) }))
    };
  }

  async deviceResources(deviceId) {
    const safeDeviceId = requireIdentifier(deviceId, 'deviceId');
    const resources = await this.provider.listDeviceResources(safeDeviceId);
    return { ...resources, generatedAt: new Date(this.clock()).toISOString() };
  }

  deviceResourceSensors(deviceId, resourceType, options) {
    return this.provider.listDeviceResourceSensors(
      requireIdentifier(deviceId, 'deviceId'),
      requireIdentifier(resourceType, 'resourceType'),
      options
    );
  }

  deviceResourceSeries(deviceId, resourceType, options) {
    return this.provider.getDeviceResourceSeries(
      requireIdentifier(deviceId, 'deviceId'),
      requireIdentifier(resourceType, 'resourceType'),
      options
    );
  }

  portHistorySeries(deviceId, portId, options) {
    return this.provider.getPortHistorySeries(
      requireIdentifier(deviceId, 'deviceId'),
      requireIdentifier(portId, 'portId'),
      options
    );
  }

  deviceGraph(deviceId, category, graphType, options) {
    return this.provider.getDeviceGraph(requireIdentifier(deviceId, 'deviceId'), category, graphType, options);
  }

  async portGraph(deviceId, portId, graphType, options) {
    const safeDeviceId = requireIdentifier(deviceId, 'deviceId');
    const port = await this.findPort(safeDeviceId, portId);
    return this.provider.getPortGraph(safeDeviceId, port.name, graphType, options);
  }

  async portArp(deviceId, portId) {
    const safeDeviceId = requireIdentifier(deviceId, 'deviceId');
    const safePortId = requireIdentifier(portId, 'portId');
    await this.findPort(safeDeviceId, safePortId);
    const entries = await this.provider.listArp(safeDeviceId);
    return { deviceId: safeDeviceId, portId: safePortId, items: entries.filter((entry) => entry.portId === safePortId) };
  }

  async deviceEvents(deviceId, options) {
    const safeDeviceId = requireIdentifier(deviceId, 'deviceId');
    return { deviceId: safeDeviceId, items: await this.provider.listEventLog(safeDeviceId, options) };
  }

  async findPort(deviceId, portId) {
    const safePortId = requireIdentifier(portId, 'portId');
    const ports = await this.provider.listPorts(deviceId);
    const port = ports.find((item) => item.id === safePortId || item.name === safePortId);
    if (!port) throw new AppError(404, 'MONITORING_PORT_NOT_FOUND', 'Port was not found');
    return port;
  }
}

function enrichPort(port, deviceName = port.deviceId) {
  const rx = Number.isFinite(port.rxBps) ? port.rxBps : 0;
  const tx = Number.isFinite(port.txBps) ? port.txBps : 0;
  const speed = Number.isFinite(port.speedBps) && port.speedBps > 0 ? port.speedBps : null;
  return {
    ...port,
    deviceName: String(deviceName || port.deviceId),
    trafficBps: rx + tx,
    utilizationPercent: speed === null ? null : round(Math.max(rx, tx) / speed * 100),
    errors: Number(port.errors) || 0,
    discards: Number(port.discards) || 0
  };
}

function metricValue(port, metric) {
  if (metric === 'utilization') return port.utilizationPercent ?? -1;
  if (metric === 'errors') return port.errors;
  if (metric === 'discards') return port.discards;
  return port.trafficBps;
}

function compareIdentifiers(left, right) {
  return String(left).localeCompare(String(right), 'en', { numeric: true, sensitivity: 'base' });
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(Math.max(number, min), max) : fallback;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
