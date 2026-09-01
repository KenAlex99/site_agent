import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app-insights.mjs';
import { MonitoringService } from '../src/monitoring-service-insights.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
let tick = 0;
const devices = [
  { id: '1', name: 'Core-SH-01', hostname: 'core-sh-01', status: 'up' },
  { id: '2', name: 'Access-SH-12', hostname: 'access-sh-12', status: 'up' },
  { id: '3', name: 'WAN-BJ-02', hostname: 'wan-bj-02', status: 'down' },
  { id: '4', name: 'Firewall-01', hostname: 'fw-01', status: 'up' }
];
const ports = [
  { id: '101', deviceId: '1', name: 'TenGigabitEthernet1/0/1', description: 'Core uplink', status: 'up', adminStatus: 'up', speedBps: 10e9, rxBps: 3.1e9, txBps: 1.7e9, errors: 2, discards: 0 },
  { id: '102', deviceId: '1', name: 'GigabitEthernet1/0/8', description: 'Access trunk', status: 'up', adminStatus: 'up', speedBps: 1e9, rxBps: 420e6, txBps: 265e6, errors: 11, discards: 4 },
  { id: '201', deviceId: '2', name: 'GigabitEthernet0/24', description: 'Distribution uplink', status: 'up', adminStatus: 'up', speedBps: 1e9, rxBps: 780e6, txBps: 330e6, errors: 0, discards: 2 },
  { id: '301', deviceId: '3', name: 'WAN0', description: 'ISP primary', status: 'down', adminStatus: 'up', speedBps: 100e6, rxBps: 0, txBps: 0, errors: 38, discards: 17 },
  { id: '401', deviceId: '4', name: 'bond0', description: 'Inside aggregate', status: 'up', adminStatus: 'up', speedBps: 2e9, rxBps: 1.2e9, txBps: 810e6, errors: 1, discards: 1 }
];

const provider = {
  descriptor: { id: 'librenms', name: 'LibreNMS Preview', configured: true },
  async health() { return { status: 'up', provider: this.descriptor }; },
  async listDevices() { return devices; },
  async listPorts(deviceId) {
    tick += 1;
    return ports.filter((port) => port.deviceId === deviceId).map((port, index) => ({
      ...port, rxBps: Math.max(0, port.rxBps + Math.sin(tick / 2 + index) * 80e6),
      txBps: Math.max(0, port.txBps + Math.cos(tick / 2 + index) * 60e6)
    }));
  },
  async listAllPorts() { return ports; },
  async listAlerts() { return [
    { id: 'a1', state: 'active', severity: 'critical', title: 'WAN-BJ-02 unreachable' },
    { id: 'a2', state: 'active', severity: 'warning', title: 'Core uplink utilization high' }
  ]; },
  async listDeviceResources(deviceId) { return {
    deviceId,
    graphs: [
      { id: 'uptime', name: 'System Uptime', category: 'device' },
      { id: 'device_ping_perf', name: 'Ping Response', category: 'device' },
      { id: 'device_processor', name: 'Processor', category: 'health' },
      { id: 'device_mempool', name: 'Memory', category: 'health' },
      { id: 'device_temperature', name: 'Temperature', category: 'health' }
    ],
    availability: [{ durationSeconds: 86400, percent: 99.98 }, { durationSeconds: 604800, percent: 99.91 }, { durationSeconds: 2592000, percent: 99.72 }]
  }; },
  async listDeviceResourceSensors(_deviceId, type) {
    if (type.includes('processor')) return [{ id: 'cpu0', resourceType: type, name: 'Processor 0', current: 37.4, unit: '%', status: 'ok', updatedAt: new Date().toISOString() }];
    if (type.includes('mempool')) return [{ id: 'ram', resourceType: type, name: 'Physical memory', current: 68.2, unit: '%', status: 'warning', updatedAt: new Date().toISOString() }];
    return [{ id: 'temp1', resourceType: type, name: 'Chassis inlet', current: 31.8, unit: '°C', status: 'ok', updatedAt: new Date().toISOString() }, { id: 'temp2', resourceType: type, name: 'ASIC zone', current: 54.6, unit: '°C', status: 'warning', updatedAt: new Date().toISOString() }];
  },
  async listArp(deviceId) { return ports.filter((port) => port.deviceId === deviceId).map((port, index) => ({ portId: port.id, ipAddress: `10.20.${deviceId}.${index + 10}`, macAddress: `00:11:22:33:${deviceId.padStart(2, '0')}:${String(index + 1).padStart(2, '0')}`, context: 'default' })); },
  async listEventLog(deviceId) { return ports.filter((port) => port.deviceId === deviceId).flatMap((port, index) => [{ id: `${deviceId}-${index}`, deviceId, type: 'interface', severity: 'info', message: `${port.name} changed state to ${port.status}`, timestamp: new Date(Date.now() - index * 300000).toISOString() }]); },
  async getDeviceGraph(_deviceId, _category, type) { return graphPayload(type); },
  async getPortGraph(_deviceId, portName) { return graphPayload(portName); }
};

function graphPayload(_title) {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XjVnAAAAAElFTkSuQmCC';
  return { contentType: 'image/png', body: Buffer.from(png, 'base64') };
}

const service = new MonitoringService(provider, { seriesLimit: 180 });
const app = createApp({ service, publicDir: resolve(packageRoot, 'public-next'), packageRoot });
createServer(app).listen(Number(process.env.PORT || 4320), '127.0.0.1', () => console.log('Preview: http://127.0.0.1:4320'));
