import { AppError, finiteNumber, isoTime, normalizeSeverity, normalizeState, requireIdentifier } from '../contracts.mjs';

const portColumns = [
  'port_id', 'device_id', 'ifName', 'ifDescr', 'ifAlias', 'ifOperStatus', 'ifAdminStatus',
  'ifSpeed', 'ifInOctets_rate', 'ifOutOctets_rate'
].join(',');

export class LibreNmsProvider {
  constructor({ baseUrl, token, timeoutMs = 5000, fetchImpl = fetch }) {
    this.baseUrl = String(baseUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '');
    this.token = String(token || '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  get descriptor() {
    return { id: 'librenms', name: 'LibreNMS', configured: Boolean(this.token) };
  }

  async health() {
    if (!this.token) return { status: 'degraded', provider: this.descriptor, message: 'LibreNMS read-only token is not configured' };
    await this.request('/devices', new URLSearchParams({ limit: '1' }));
    return { status: 'up', provider: this.descriptor };
  }

  async listDevices() {
    const body = await this.request('/devices', new URLSearchParams({ type: 'active' }));
    return arrayOf(body.devices).map(normalizeDevice);
  }

  async listPorts(deviceId) {
    const id = requireIdentifier(deviceId, 'deviceId');
    const query = new URLSearchParams({ columns: portColumns });
    const body = await this.request(`/devices/${encodeURIComponent(id)}/ports`, query);
    return arrayOf(body.ports).map(normalizePort);
  }

  async listAlerts({ state = 'all', limit = 50 } = {}) {
    const safeState = ['all', 'active', 'ack', 'unack', 'open'].includes(state) ? state : 'all';
    const query = new URLSearchParams({ limit: String(Math.min(Math.max(Number(limit) || 50, 1), 100)) });
    if (safeState !== 'all') query.set('state', safeState);
    const body = await this.request('/alerts', query);
    return arrayOf(body.alerts).map(normalizeAlert);
  }

  async request(path, search = new URLSearchParams()) {
    if (!this.token) throw new AppError(503, 'MONITORING_PROVIDER_NOT_CONFIGURED', 'LibreNMS provider is not configured');
    const url = `${this.baseUrl}/api/v0${path}${search.size ? `?${search}` : ''}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: { 'X-Auth-Token': this.token, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new AppError(502, 'MONITORING_PROVIDER_UNAVAILABLE', 'LibreNMS did not respond in time', { cause: error });
    }
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; }
    catch { throw new AppError(502, 'MONITORING_PROVIDER_INVALID_RESPONSE', 'LibreNMS returned an invalid response'); }
    if (!response.ok) throw new AppError(502, 'MONITORING_PROVIDER_REJECTED', `LibreNMS request failed with HTTP ${response.status}`);
    return body;
  }
}

function arrayOf(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function normalizeDevice(device) {
  const id = String(device.device_id ?? device.hostname ?? '');
  return {
    id,
    name: String(device.display ?? device.sysName ?? device.hostname ?? id),
    hostname: String(device.hostname ?? ''),
    status: normalizeState(device.status),
    disabled: normalizeState(device.disabled, 'disabled', 'enabled') === 'disabled',
    os: String(device.os ?? 'unknown'),
    hardware: String(device.hardware ?? ''),
    location: String(device.location ?? device.location_name ?? ''),
    lastPolledAt: isoTime(device.last_polled)
  };
}

function normalizePort(port) {
  const inBits = finiteNumber(port.ifInBits_rate);
  const outBits = finiteNumber(port.ifOutBits_rate);
  const inOctets = finiteNumber(port.ifInOctets_rate);
  const outOctets = finiteNumber(port.ifOutOctets_rate);
  return {
    id: String(port.port_id ?? port.ifName ?? ''),
    deviceId: String(port.device_id ?? ''),
    name: String(port.ifName ?? port.ifDescr ?? port.port_id ?? ''),
    description: String(port.ifAlias ?? port.ifDescr ?? ''),
    status: normalizeState(port.ifOperStatus),
    adminStatus: normalizeState(port.ifAdminStatus),
    speedBps: finiteNumber(port.ifSpeed),
    rxBps: inBits ?? (inOctets === null ? null : inOctets * 8),
    txBps: outBits ?? (outOctets === null ? null : outOctets * 8)
  };
}

function normalizeAlert(alert) {
  const id = String(alert.id ?? alert.alert_id ?? '');
  const state = alert.state === 0 || alert.state === '0' ? 'ok'
    : alert.state === 2 || alert.state === '2' ? 'acknowledged'
      : alert.state === 1 || alert.state === '1' ? 'active' : String(alert.state || 'unknown').toLowerCase();
  return {
    id,
    deviceId: String(alert.device_id ?? alert.device?.device_id ?? ''),
    deviceName: String(alert.hostname ?? alert.device?.hostname ?? alert.device_id ?? ''),
    ruleId: String(alert.rule_id ?? ''),
    title: String(alert.name ?? alert.rule_name ?? alert.title ?? `Alert ${id}`),
    severity: normalizeSeverity(alert.severity),
    state,
    acknowledged: state === 'acknowledged' || Boolean(alert.acknowledged),
    openedAt: isoTime(alert.timestamp ?? alert.opened_at),
    updatedAt: isoTime(alert.updated_at ?? alert.timestamp),
    note: String(alert.note ?? '')
  };
}

export const libreNmsNormalizers = { normalizeDevice, normalizePort, normalizeAlert };
