import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.mjs';
import { MonitoringService } from '../src/monitoring-service.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
let tick = 0;
const ports = [
  { id: '101', deviceId: '1', name: 'TenGigabitEthernet1/0/1', description: 'Core uplink', status: 'up', adminStatus: 'up', speedBps: 10e9, rxBps: 3.1e9, txBps: 1.7e9 },
  { id: '102', deviceId: '1', name: 'GigabitEthernet1/0/8', description: 'Access trunk', status: 'up', adminStatus: 'up', speedBps: 1e9, rxBps: 420e6, txBps: 265e6 }
];
const provider = {
  descriptor: { id: 'librenms', name: 'LibreNMS', configured: true },
  async health() { return { status: 'up', provider: this.descriptor }; },
  async listDevices() { return [{ id: '1', name: 'Core-SH-01', hostname: 'core-sh-01', status: 'up' }, { id: '2', name: 'Access-SH-12', hostname: 'access-sh-12', status: 'up' }, { id: '3', name: 'WAN-BJ-02', hostname: 'wan-bj-02', status: 'down' }, { id: '4', name: 'Firewall-01', hostname: 'fw-01', status: 'up' }]; },
  async listPorts() { tick += 1; return ports.map((port, index) => ({ ...port, rxBps: port.rxBps + Math.sin(tick / 2 + index) * 120e6, txBps: port.txBps + Math.cos(tick / 2 + index) * 90e6 })); },
  async listAlerts() { return [{ id: 'a1', deviceId: '3', deviceName: 'WAN-BJ-02', title: '设备连续三轮不可达', severity: 'critical', state: 'active', openedAt: new Date(Date.now() - 420000).toISOString() }, { id: 'a2', deviceId: '1', deviceName: 'Core-SH-01', title: '上联端口利用率超过 80%', severity: 'warning', state: 'active', openedAt: new Date(Date.now() - 120000).toISOString() }, { id: 'a3', deviceId: '4', deviceName: 'Firewall-01', title: '会话数接近容量阈值', severity: 'info', state: 'acknowledged', openedAt: new Date(Date.now() - 1800000).toISOString() }]; }
};
const service = new MonitoringService(provider, { seriesLimit: 180 });
const app = createApp({ service, publicDir: resolve(packageRoot, 'public-next'), packageRoot });
createServer(app).listen(Number(process.env.PORT || 4320), '127.0.0.1');
