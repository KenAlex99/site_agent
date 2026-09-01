import { AppError, requireIdentifier } from './contracts.mjs';

export class MonitoringService {
  constructor(provider, { seriesLimit = 180, clock = () => Date.now() } = {}) {
    this.provider = provider;
    this.seriesLimit = seriesLimit;
    this.clock = clock;
    this.samples = new Map();
  }

  health() { return this.provider.health(); }
  devices() { return this.provider.listDevices(); }
  ports(deviceId) { return this.provider.listPorts(requireIdentifier(deviceId, 'deviceId')); }
  alerts(options) { return this.provider.listAlerts(options); }

  async overview() {
    const [devices, alerts] = await Promise.all([this.devices(), this.alerts({ state: 'all', limit: 100 })]);
    const deviceStates = countBy(devices, (item) => item.status);
    const activeAlerts = alerts.filter((item) => item.state !== 'ok');
    return {
      generatedAt: new Date(this.clock()).toISOString(),
      provider: this.provider.descriptor,
      devices: { total: devices.length, up: deviceStates.up || 0, down: deviceStates.down || 0, states: deviceStates },
      alerts: { total: alerts.length, active: alerts.filter((item) => item.state === 'active').length, severities: countBy(activeAlerts, (item) => item.severity) }
    };
  }

  async portTrafficSeries(deviceId, portId) {
    const safeDeviceId = requireIdentifier(deviceId, 'deviceId');
    const safePortId = requireIdentifier(portId, 'portId');
    const ports = await this.provider.listPorts(safeDeviceId);
    const port = ports.find((item) => item.id === safePortId || item.name === safePortId);
    if (!port) throw new AppError(404, 'MONITORING_PORT_NOT_FOUND', 'Port was not found');
    const key = `${safeDeviceId}\u0000${safePortId}`;
    const points = this.samples.get(key) || [];
    const timestamp = Math.floor(this.clock() / 1000);
    const last = points.at(-1);
    if (!last || last.time !== timestamp) points.push({ time: timestamp, rx: port.rxBps, tx: port.txBps });
    if (points.length > this.seriesLimit) points.splice(0, points.length - this.seriesLimit);
    this.samples.set(key, points);
    return {
      id: `port-traffic:${safeDeviceId}:${safePortId}`,
      title: `${port.name} traffic`,
      unit: 'bps',
      sampledAt: new Date(timestamp * 1000).toISOString(),
      sampleMode: 'middleware-rolling-window',
      series: [
        { id: 'rx', name: 'Inbound', points: points.map((item) => [item.time, item.rx]) },
        { id: 'tx', name: 'Outbound', points: points.map((item) => [item.time, item.tx]) }
      ]
    };
  }
}

function countBy(items, selector) {
  return items.reduce((result, item) => {
    const key = selector(item) || 'unknown';
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
}
